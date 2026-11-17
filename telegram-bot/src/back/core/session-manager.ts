import crypto from 'crypto';
import { ulid } from 'ulid';
import {
  ChannelSessionIssued,
  ChannelSessionUser,
  CoreApiError,
  TelegramIdentityInput,
} from '../../contracts';
import { TelegramAccountsRepository } from '../storage/accounts.repo';
import { RedisLike } from '../storage/redis-stores';
import { parseCoreError, ServiceAuthManager } from './service-auth';

const ACCESS_SAFETY_MARGIN_SEC = 30;
const MIN_ACCESS_TTL_SEC = 30;
const DEFAULT_LOCK_TTL_SEC = 10;
const DEFAULT_LOCK_WAIT_MS = 2000;
const DEFAULT_LOCK_POLL_MS = 50;

const FATAL_SESSION_CODES = new Set([
  'INVALID_GRANT',
  'EXPIRED_TOKEN',
  'SESSION_REVOKED',
  'ACCOUNT_BLOCKED',
]);

/** Respuesta completa de emisión/rotación de sesión devuelta por el Core (`EP-C-06`). */
export interface CoreIssuedSessionPayload {
  accessToken: string;
  accessTokenExpiresIn: number;
  refreshToken: string;
  refreshTokenExpiresIn: number;
  session: { id: string; absoluteExpiresAt: string };
  user: ChannelSessionUser;
}

export interface ChannelSessionManagerConfig {
  coreApiUrl: string;
  redis: RedisLike;
  accountsRepo: TelegramAccountsRepository;
  serviceAuth: ServiceAuthManager;
  fetchImpl?: typeof fetch;
  lockTtlSec?: number;
  lockWaitMs?: number;
  lockPollMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Gestiona las sesiones de canal de Telegram (§6.2, §6.8, §9.3):
 *  · Guarda `refreshToken` cifrado en `bot-db` y `accessToken` en Redis (`tg:sess:access:*`).
 *  · Serializa la rotación de `refreshToken` por usuario (`inFlight` + lock distribuido
 *    `tg:lock:refresh:*`) para evitar que dos llamadas simultáneas disparen `REUSE_DETECTED`.
 */
export class ChannelSessionManager {
  private readonly baseUrl: string;
  private readonly redis: RedisLike;
  private readonly accountsRepo: TelegramAccountsRepository;
  private readonly serviceAuth: ServiceAuthManager;
  private readonly fetchImpl: typeof fetch;
  private readonly lockTtlSec: number;
  private readonly lockWaitMs: number;
  private readonly lockPollMs: number;

  private readonly inFlightByUser = new Map<string, Promise<string>>();

  constructor(config: ChannelSessionManagerConfig) {
    this.baseUrl = config.coreApiUrl.replace(/\/+$/, '');
    this.redis = config.redis;
    this.accountsRepo = config.accountsRepo;
    this.serviceAuth = config.serviceAuth;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.lockTtlSec = config.lockTtlSec ?? DEFAULT_LOCK_TTL_SEC;
    this.lockWaitMs = config.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS;
    this.lockPollMs = config.lockPollMs ?? DEFAULT_LOCK_POLL_MS;
  }

  private accessKey(externalUserId: string): string {
    return `tg:sess:access:${externalUserId}`;
  }

  private lockKey(externalUserId: string): string {
    return `tg:lock:refresh:${externalUserId}`;
  }

  private async cacheAccessToken(
    externalUserId: string,
    accessToken: string,
    expiresInSec: number,
  ): Promise<void> {
    const ttlSec = Math.max(MIN_ACCESS_TTL_SEC, expiresInSec - ACCESS_SAFETY_MARGIN_SEC);
    await this.redis.set(this.accessKey(externalUserId), accessToken, 'EX', ttlSec);
  }

  /** Comprueba si el usuario tiene sesión vinculada localmente (Redis o `bot-db`). */
  async isLinked(externalUserId: string): Promise<boolean> {
    if ((await this.redis.exists(this.accessKey(externalUserId))) > 0) {
      return true;
    }
    const account = await this.accountsRepo.findByTelegramUserId(externalUserId);
    return account !== null;
  }

  /** Persiste la sesión emitida por el Core en `bot-db` (cifrada) y en Redis. */
  async saveIssuedSession(
    tg: TelegramIdentityInput,
    payload: CoreIssuedSessionPayload,
  ): Promise<ChannelSessionIssued> {
    await this.accountsRepo.upsertAccount({
      telegramUserId: tg.externalUserId,
      chatId: tg.chatId,
      coreUserId: payload.user.id,
      channelSessionId: payload.session.id,
      refreshToken: payload.refreshToken,
    });
    await this.cacheAccessToken(
      tg.externalUserId,
      payload.accessToken,
      payload.accessTokenExpiresIn,
    );

    return {
      kind: 'session',
      user: payload.user,
      sessionId: payload.session.id,
      absoluteExpiresAt: payload.session.absoluteExpiresAt,
    };
  }

  /** Devuelve un `accessToken` vigente desde Redis o rota la sesión si expiró. */
  async getValidAccessToken(externalUserId: string, requestId?: string): Promise<string> {
    const cached = await this.redis.get(this.accessKey(externalUserId));
    if (cached) {
      return cached;
    }
    return this.refreshSession(externalUserId, requestId);
  }

  /** Rota el `refreshToken` contra `EP-C-06` de forma serializada por usuario. */
  async refreshSession(externalUserId: string, requestId?: string): Promise<string> {
    const existing = this.inFlightByUser.get(externalUserId);
    if (existing) {
      return existing;
    }

    const promise = this.performLockedRefresh(externalUserId, requestId).finally(() => {
      this.inFlightByUser.delete(externalUserId);
    });
    this.inFlightByUser.set(externalUserId, promise);
    return promise;
  }

  private async performLockedRefresh(externalUserId: string, requestId?: string): Promise<string> {
    const lockKey = this.lockKey(externalUserId);
    const lockId = crypto.randomUUID();
    const deadline = Date.now() + this.lockWaitMs;

    let acquired = (await this.redis.set(lockKey, lockId, 'EX', this.lockTtlSec, 'NX')) === 'OK';

    while (!acquired && Date.now() < deadline) {
      await sleep(this.lockPollMs);
      // Si otra réplica terminó el refresco, reutilizamos su accessToken recién guardado
      const freshToken = await this.redis.get(this.accessKey(externalUserId));
      if (freshToken) {
        return freshToken;
      }
      acquired = (await this.redis.set(lockKey, lockId, 'EX', this.lockTtlSec, 'NX')) === 'OK';
    }

    if (!acquired) {
      throw new CoreApiError(
        503,
        'SESSION_REFRESH_TIMEOUT',
        'No se pudo renovar la sesión a tiempo, inténtalo de nuevo',
      );
    }

    try {
      // Double-check tras obtener el lock por si otra réplica lo publicó justo antes
      const cachedAfterLock = await this.redis.get(this.accessKey(externalUserId));
      if (cachedAfterLock) {
        return cachedAfterLock;
      }

      const account = await this.accountsRepo.findByTelegramUserId(externalUserId);
      if (!account) {
        throw new CoreApiError(401, 'UNAUTHORIZED', 'Debes vincular o iniciar sesión primero');
      }

      return await this.executeTokenRefresh(externalUserId, account.refreshToken, requestId);
    } finally {
      const currentOwner = await this.redis.get(lockKey).catch(() => null);
      if (currentOwner === lockId) {
        await this.redis.del(lockKey).catch(() => undefined);
      }
    }
  }

  private async executeTokenRefresh(
    externalUserId: string,
    refreshToken: string,
    requestId?: string,
  ): Promise<string> {
    const reqId = requestId ?? ulid();
    const serviceToken = await this.serviceAuth.getToken(reqId);

    const res = await this.fetchImpl(`${this.baseUrl}/channel-auth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept-Language': 'es',
        'X-Service-Authorization': `Bearer ${serviceToken}`,
        'X-Request-Id': reqId,
      },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        channel: 'telegram',
        externalUserId,
        refreshToken,
      }),
    });

    if (!res.ok) {
      const err = await parseCoreError(res, reqId);
      if (err.code === 'SERVICE_UNAUTHORIZED') {
        this.serviceAuth.invalidate();
      } else if (FATAL_SESSION_CODES.has(err.code)) {
        await this.clearLocalSession(externalUserId);
      }
      throw err;
    }

    const issued = (await res.json()) as CoreIssuedSessionPayload;
    await this.accountsRepo.updateRotatedSession(
      externalUserId,
      issued.session.id,
      issued.refreshToken,
    );
    await this.cacheAccessToken(externalUserId, issued.accessToken, issued.accessTokenExpiresIn);
    return issued.accessToken;
  }

  /** Elimina la sesión local de un usuario en Redis y en `bot-db`. */
  async clearLocalSession(externalUserId: string): Promise<void> {
    await this.redis.del(this.accessKey(externalUserId));
    await this.accountsRepo.deleteByTelegramUserId(externalUserId);
  }

  /** Elimina la sesión asociada a un `sessionId` revocado. */
  async clearBySessionId(sessionId: string, externalUserId?: string): Promise<void> {
    if (externalUserId) {
      await this.redis.del(this.accessKey(externalUserId));
    }
    await this.accountsRepo.deleteBySessionId(sessionId);
  }

  /** Elimina todas las sesiones locales de un `coreUserId` (p. ej. ante `account.blocked`). */
  async clearByCoreUserId(coreUserId: string): Promise<string[]> {
    const accounts = await this.accountsRepo.findByCoreUserIds([coreUserId]);
    if (accounts.length > 0) {
      await this.redis.del(...accounts.map((a) => this.accessKey(a.telegramUserId)));
    }
    await this.accountsRepo.deleteByCoreUserId(coreUserId);
    return accounts.map((a) => a.chatId);
  }
}
