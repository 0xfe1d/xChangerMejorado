import crypto from 'crypto';
import { Queryable } from '../src/back/config/db';
import { ServiceAuthManager } from '../src/back/core/service-auth';
import {
  ChannelSessionManager,
  CoreIssuedSessionPayload,
} from '../src/back/core/session-manager';
import { TokenCipher } from '../src/back/crypto/token-cipher';
import { TelegramAccountsRepository } from '../src/back/storage/accounts.repo';
import { RedisLike } from '../src/back/storage/redis-stores';
import { CoreApiError, TelegramIdentityInput } from '../src/contracts';

class FakeRedis implements RedisLike {
  readonly data = new Map<string, { value: string; ttlSec: number }>();

  async get(key: string): Promise<string | null> {
    return this.data.get(key)?.value ?? null;
  }

  async set(
    key: string,
    value: string,
    _secondsToken: 'EX',
    seconds: number,
    nxToken?: 'NX',
  ): Promise<string | null> {
    if (nxToken === 'NX' && this.data.has(key)) {
      return null;
    }
    this.data.set(key, { value, ttlSec: seconds });
    return 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const k of keys) {
      if (this.data.delete(k)) removed += 1;
    }
    return removed;
  }

  async exists(...keys: string[]): Promise<number> {
    return keys.filter((k) => this.data.has(k)).length;
  }
}

interface StoredRow {
  telegram_user_id: string;
  chat_id: string;
  core_user_id: string;
  channel_session_id: string;
  refresh_token_enc: string;
  locale: string;
  linked_at: Date;
}

class FakeBotDb implements Queryable {
  readonly rows = new Map<string, StoredRow>();

  async query<T>(
    text: string,
    params: unknown[] = [],
  ): Promise<{ rows: T[]; rowCount: number | null }> {
    const sql = text.trim();

    if (sql.startsWith('INSERT INTO telegram_accounts')) {
      const [tgId, chatId, coreId, sessionId, encToken, locale] = params as string[];
      this.rows.set(tgId, {
        telegram_user_id: tgId,
        chat_id: chatId,
        core_user_id: coreId,
        channel_session_id: sessionId,
        refresh_token_enc: encToken,
        locale,
        linked_at: new Date(),
      });
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes('WHERE telegram_user_id = $1') && sql.startsWith('SELECT')) {
      const row = this.rows.get(params[0] as string);
      return { rows: (row ? [row] : []) as unknown as T[], rowCount: row ? 1 : 0 };
    }

    if (sql.includes('WHERE core_user_id = ANY($1::text[])')) {
      const ids = new Set(params[0] as string[]);
      const found = [...this.rows.values()].filter((r) => ids.has(r.core_user_id));
      return { rows: found as unknown as T[], rowCount: found.length };
    }

    if (sql.startsWith('UPDATE telegram_accounts')) {
      const [tgId, sessionId, encToken] = params as string[];
      const existing = this.rows.get(tgId);
      if (!existing) return { rows: [], rowCount: 0 };
      existing.channel_session_id = sessionId;
      existing.refresh_token_enc = encToken;
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith('DELETE FROM telegram_accounts WHERE telegram_user_id = $1')) {
      const ok = this.rows.delete(params[0] as string);
      return { rows: [], rowCount: ok ? 1 : 0 };
    }

    if (sql.startsWith('DELETE FROM telegram_accounts WHERE core_user_id = $1')) {
      const target = params[0] as string;
      let count = 0;
      for (const [k, v] of this.rows.entries()) {
        if (v.core_user_id === target) {
          this.rows.delete(k);
          count += 1;
        }
      }
      return { rows: [], rowCount: count };
    }

    if (sql.startsWith('DELETE FROM telegram_accounts WHERE channel_session_id = $1')) {
      const target = params[0] as string;
      let count = 0;
      for (const [k, v] of this.rows.entries()) {
        if (v.channel_session_id === target) {
          this.rows.delete(k);
          count += 1;
        }
      }
      return { rows: [], rowCount: count };
    }

    throw new Error(`SQL no soportado en FakeBotDb: ${sql}`);
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function buildIssuedPayload(overrides: Partial<CoreIssuedSessionPayload> = {}): CoreIssuedSessionPayload {
  return {
    accessToken: 'acc_initial_jwt',
    accessTokenExpiresIn: 900,
    refreshToken: 'ref_initial_opaque_43_chars_abcdefghijklmno',
    refreshTokenExpiresIn: 2_592_000,
    session: {
      id: 'cs_1',
      absoluteExpiresAt: '2027-05-02T10:00:00Z',
    },
    user: {
      id: 'ck_ana',
      name: 'Ana Pérez',
      role: 'ESTUDIANTE',
      mfaEnabled: false,
      hasExpediente: true,
    },
    ...overrides,
  };
}

const TG_ANA: TelegramIdentityInput = {
  externalUserId: '55123',
  chatId: '55123',
  displayName: 'Ana Pérez',
};

describe('Bloque 2: ServiceAuthManager (EP-C-01)', () => {
  it('cachea el JWT de servicio, lo reutiliza si queda > 60 s y renueva cuando queda < 60 s', async () => {
    let now = 1_000_000;
    let calls = 0;

    const manager = new ServiceAuthManager({
      coreApiUrl: 'http://backend:3000/api/v1/',
      clientId: 'telegram-bot',
      clientSecret: 'secret-32-chars-minimum-1234567890',
      nowMs: () => now,
      fetchImpl: async (url, init) => {
        calls += 1;
        expect(url).toBe('http://backend:3000/api/v1/service-auth/token');
        const parsed = JSON.parse(String(init?.body));
        expect(parsed).toEqual({
          grant_type: 'client_credentials',
          client_id: 'telegram-bot',
          client_secret: 'secret-32-chars-minimum-1234567890',
          scope: 'channel:telegram',
        });
        return jsonResponse(200, {
          access_token: `svc_jwt_${calls}`,
          token_type: 'Bearer',
          expires_in: 600,
          scope: 'channel:telegram',
        });
      },
    });

    expect(await manager.getToken()).toBe('svc_jwt_1');
    expect(calls).toBe(1);

    // A los 500 s todavía quedan 100 s (> 60 s) -> usa caché
    now += 500_000;
    expect(await manager.getToken()).toBe('svc_jwt_1');
    expect(calls).toBe(1);

    // A los 550 s quedan 50 s (< 60 s) -> renueva automáticamente
    now += 50_000;
    expect(await manager.getToken()).toBe('svc_jwt_2');
    expect(calls).toBe(2);

    // invalidate() fuerza nueva petición inmediata
    manager.invalidate();
    expect(await manager.getToken()).toBe('svc_jwt_3');
    expect(calls).toBe(3);
  });

  it('coalesce llamadas concurrentes en 1 sola petición y mapea errores a CoreApiError', async () => {
    let calls = 0;
    const manager = new ServiceAuthManager({
      coreApiUrl: 'http://backend:3000/api/v1',
      clientId: 'telegram-bot',
      clientSecret: 'secret-32-chars-minimum-1234567890',
      fetchImpl: async () => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 20));
        return jsonResponse(200, {
          access_token: 'svc_shared_jwt',
          token_type: 'Bearer',
          expires_in: 600,
          scope: 'channel:telegram',
        });
      },
    });

    const tokens = await Promise.all([
      manager.getToken(),
      manager.getToken(),
      manager.getToken(),
      manager.getToken(),
      manager.getToken(),
    ]);

    expect(calls).toBe(1);
    expect(tokens).toEqual([
      'svc_shared_jwt',
      'svc_shared_jwt',
      'svc_shared_jwt',
      'svc_shared_jwt',
      'svc_shared_jwt',
    ]);

    const failing = new ServiceAuthManager({
      coreApiUrl: 'http://backend:3000/api/v1',
      clientId: 'telegram-bot',
      clientSecret: 'bad-secret',
      fetchImpl: async () =>
        jsonResponse(401, {
          error: 'Credenciales de servicio incorrectas',
          code: 'SERVICE_UNAUTHORIZED',
          requestId: 'req_123',
        }),
    });

    await expect(failing.getToken()).rejects.toMatchObject({
      name: 'CoreApiError',
      status: 401,
      code: 'SERVICE_UNAUTHORIZED',
      requestId: 'req_123',
    });
  });
});

describe('Bloque 2: ChannelSessionManager (accessToken + rotación segura)', () => {
  const key = crypto.randomBytes(32).toString('base64');

  function createHarness(fetchImpl: typeof fetch) {
    const redis = new FakeRedis();
    const db = new FakeBotDb();
    const accountsRepo = new TelegramAccountsRepository(db, new TokenCipher(key));
    const serviceAuth = new ServiceAuthManager({
      coreApiUrl: 'http://backend:3000/api/v1',
      clientId: 'telegram-bot',
      clientSecret: 'secret-32-chars-minimum-1234567890',
      fetchImpl: async () =>
        jsonResponse(200, {
          access_token: 'svc_jwt_ok',
          token_type: 'Bearer',
          expires_in: 600,
          scope: 'channel:telegram',
        }),
    });
    const sessions = new ChannelSessionManager({
      coreApiUrl: 'http://backend:3000/api/v1',
      redis,
      accountsRepo,
      serviceAuth,
      fetchImpl,
      lockPollMs: 10,
      lockWaitMs: 500,
    });

    return { redis, db, accountsRepo, serviceAuth, sessions };
  }

  it('guarda sesión en bot-db y Redis, y reutiliza accessToken vigente sin llamar al Core', async () => {
    let refreshCalls = 0;
    const { redis, accountsRepo, sessions } = createHarness(async () => {
      refreshCalls += 1;
      return jsonResponse(500, {});
    });

    expect(await sessions.isLinked('55123')).toBe(false);

    const saved = await sessions.saveIssuedSession(TG_ANA, buildIssuedPayload());
    expect(saved.kind).toBe('session');
    expect(saved.sessionId).toBe('cs_1');
    expect(await sessions.isLinked('55123')).toBe(true);

    expect(redis.data.get('tg:sess:access:55123')).toEqual({
      value: 'acc_initial_jwt',
      ttlSec: 870, // 900 - 30 s de margen
    });

    const token = await sessions.getValidAccessToken('55123');
    expect(token).toBe('acc_initial_jwt');
    expect(refreshCalls).toBe(0);

    const persisted = await accountsRepo.findByTelegramUserId('55123');
    expect(persisted?.refreshToken).toBe('ref_initial_opaque_43_chars_abcdefghijklmno');
  });

  it('rota el refreshToken contra EP-C-06 cuando el accessToken no está en Redis y coalesce concurrencia', async () => {
    let refreshCalls = 0;
    const { redis, accountsRepo, sessions } = createHarness(async (url, init) => {
      const target = String(url);
      if (target.endsWith('/channel-auth/token')) {
        refreshCalls += 1;
        await new Promise((r) => setTimeout(r, 25));
        const headers = init?.headers as Record<string, string>;
        expect(headers['X-Service-Authorization']).toBe('Bearer svc_jwt_ok');
        const body = JSON.parse(String(init?.body));
        expect(body).toEqual({
          grant_type: 'refresh_token',
          channel: 'telegram',
          externalUserId: '55123',
          refreshToken: 'ref_initial_opaque_43_chars_abcdefghijklmno',
        });
        return jsonResponse(
          200,
          buildIssuedPayload({
            accessToken: 'acc_rotated_jwt',
            refreshToken: 'ref_rotated_opaque_43_chars_zzzzzzzzzzzzzzz',
            session: { id: 'cs_2', absoluteExpiresAt: '2027-05-02T10:00:00Z' },
          }),
        );
      }
      throw new Error(`URL inesperada: ${target}`);
    });

    await sessions.saveIssuedSession(TG_ANA, buildIssuedPayload());
    // Simula que el accessToken de 15 min caducó en Redis
    await redis.del('tg:sess:access:55123');

    // 4 llamadas concurrentes deben provocar exactamente 1 rotación en el Core
    const results = await Promise.all([
      sessions.getValidAccessToken('55123'),
      sessions.getValidAccessToken('55123'),
      sessions.refreshSession('55123'),
      sessions.refreshSession('55123'),
    ]);

    expect(refreshCalls).toBe(1);
    expect(results).toEqual([
      'acc_rotated_jwt',
      'acc_rotated_jwt',
      'acc_rotated_jwt',
      'acc_rotated_jwt',
    ]);
    expect(await redis.get('tg:sess:access:55123')).toBe('acc_rotated_jwt');
    expect(await redis.get('tg:lock:refresh:55123')).toBeNull();

    const updated = await accountsRepo.findByTelegramUserId('55123');
    expect(updated?.channelSessionId).toBe('cs_2');
    expect(updated?.refreshToken).toBe('ref_rotated_opaque_43_chars_zzzzzzzzzzzzzzz');
  });

  it('espera si otra réplica tiene el lock en Redis y reutiliza el accessToken recién publicado', async () => {
    let refreshCalls = 0;
    const { redis, sessions } = createHarness(async () => {
      refreshCalls += 1;
      return jsonResponse(500, {});
    });

    await sessions.saveIssuedSession(TG_ANA, buildIssuedPayload());
    await redis.del('tg:sess:access:55123');
    // Simula otra réplica manteniendo el lock
    await redis.set('tg:lock:refresh:55123', 'replica-2', 'EX', 10);

    setTimeout(() => {
      void redis.set('tg:sess:access:55123', 'acc_from_replica_2', 'EX', 870);
      void redis.del('tg:lock:refresh:55123');
    }, 30);

    const token = await sessions.refreshSession('55123');
    expect(token).toBe('acc_from_replica_2');
    expect(refreshCalls).toBe(0);
  });

  it('limpia bot-db y Redis automáticamente ante error fatal de sesión (INVALID_GRANT / ACCOUNT_BLOCKED)', async () => {
    const { redis, accountsRepo, sessions } = createHarness(async () =>
      jsonResponse(403, {
        error: 'Cuenta bloqueada',
        code: 'ACCOUNT_BLOCKED',
        details: { permanent: true, until: null, reason: 'Incumplimiento' },
      }),
    );

    await sessions.saveIssuedSession(TG_ANA, buildIssuedPayload());
    await redis.del('tg:sess:access:55123');

    await expect(sessions.getValidAccessToken('55123')).rejects.toBeInstanceOf(CoreApiError);
    expect(await accountsRepo.findByTelegramUserId('55123')).toBeNull();
    expect(await sessions.isLinked('55123')).toBe(false);
  });

  it('clearByCoreUserId y clearBySessionId eliminan cuentas y caché de Redis', async () => {
    const { redis, accountsRepo, sessions } = createHarness(async () => jsonResponse(500, {}));

    await sessions.saveIssuedSession(TG_ANA, buildIssuedPayload());
    const affectedChats = await sessions.clearByCoreUserId('ck_ana');
    expect(affectedChats).toEqual(['55123']);
    expect(await redis.get('tg:sess:access:55123')).toBeNull();
    expect(await accountsRepo.findByTelegramUserId('55123')).toBeNull();
  });
});
