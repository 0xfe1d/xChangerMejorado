import crypto from 'crypto';
import { CallbackPayload, CallbackStore, ConversationState, StateStore } from '../../contracts';

const DEFAULT_STATE_TTL_SEC = 15 * 60;
const DEFAULT_CB_TTL_SEC = 24 * 60 * 60;
const DEFAULT_LINK_TTL_SEC = 10 * 60;
const DEFAULT_DEDUP_TTL_SEC = 24 * 60 * 60;

const CALLBACK_KEY_RE = /^cb:[0-9a-f]{16}$/;

/** Subconjunto mínimo de comandos Redis usados por los almacenes del bot. */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, secondsToken: 'EX', seconds: number): Promise<unknown>;
  set(
    key: string,
    value: string,
    secondsToken: 'EX',
    seconds: number,
    nxToken: 'NX',
  ): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  exists(...keys: string[]): Promise<number>;
}

export interface PendingLinkData {
  deviceCode: string;
  userCode: string;
  chatId: string;
  displayName: string;
  username?: string;
  createdAt: string;
}

function safeParseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Almacén distribuido de máquina de estados conversacionales en Redis (§6.2).
 * Prefijo `tg:state:` exigido por la ACL por servicio (§11), TTL por defecto de 15 min.
 */
export class RedisStateStore implements StateStore {
  constructor(private readonly redis: RedisLike) {}

  private key(chatId: string): string {
    return `tg:state:${chatId}`;
  }

  async get(chatId: string): Promise<ConversationState | null> {
    const raw = await this.redis.get(this.key(chatId));
    return safeParseJson<ConversationState>(raw);
  }

  async set(
    chatId: string,
    state: ConversationState,
    ttlSec = DEFAULT_STATE_TTL_SEC,
  ): Promise<void> {
    await this.redis.set(this.key(chatId), JSON.stringify(state), 'EX', ttlSec);
  }

  async clear(chatId: string): Promise<void> {
    await this.redis.del(this.key(chatId));
  }
}

/**
 * Mapa de claves cortas (< 64 bytes) para botones inline de Telegram (§6.2).
 * Devuelve `cb:<16_hex>` (19 bytes) y almacena el payload completo bajo `tg:cb:*`.
 */
export class RedisCallbackStore implements CallbackStore {
  constructor(private readonly redis: RedisLike) {}

  private redisKey(shortKey: string): string {
    return `tg:${shortKey}`;
  }

  async encode(payload: CallbackPayload, ttlSec = DEFAULT_CB_TTL_SEC): Promise<string> {
    const shortKey = `cb:${crypto.randomBytes(8).toString('hex')}`;
    await this.redis.set(this.redisKey(shortKey), JSON.stringify(payload), 'EX', ttlSec);
    return shortKey;
  }

  async decode(key: string): Promise<CallbackPayload | null> {
    if (!CALLBACK_KEY_RE.test(key)) {
      return null;
    }
    const raw = await this.redis.get(this.redisKey(key));
    return safeParseJson<CallbackPayload>(raw);
  }
}

/**
 * Guarda temporalmente el `deviceCode` de una solicitud `/vincular` (10 min) para poder
 * canjear la sesión automáticamente en cuanto llegue el evento `channel.link.approved`.
 */
export class RedisPendingLinkStore {
  constructor(private readonly redis: RedisLike) {}

  private key(externalUserId: string): string {
    return `tg:link:${externalUserId}`;
  }

  async save(
    externalUserId: string,
    data: PendingLinkData,
    ttlSec = DEFAULT_LINK_TTL_SEC,
  ): Promise<void> {
    await this.redis.set(this.key(externalUserId), JSON.stringify(data), 'EX', ttlSec);
  }

  async get(externalUserId: string): Promise<PendingLinkData | null> {
    const raw = await this.redis.get(this.key(externalUserId));
    return safeParseJson<PendingLinkData>(raw);
  }

  async delete(externalUserId: string): Promise<void> {
    await this.redis.del(this.key(externalUserId));
  }

  async consume(externalUserId: string): Promise<PendingLinkData | null> {
    const pending = await this.get(externalUserId);
    if (!pending) return null;
    await this.delete(externalUserId);
    return pending;
  }
}

/**
 * Deduplicación de updates de Telegram y eventos del bus en Redis (24 h, §6.2).
 */
export class RedisDedupStore {
  constructor(private readonly redis: RedisLike) {}

  /**
   * Marca atómicamente un `update_id` como procesado.
   * Devuelve `true` solo la primera vez; `false` si ya existía (update duplicado).
   */
  async markTelegramUpdateOnce(
    updateId: number,
    ttlSec = DEFAULT_DEDUP_TTL_SEC,
  ): Promise<boolean> {
    const res = await this.redis.set(`tg:upd:${updateId}`, '1', 'EX', ttlSec, 'NX');
    return res === 'OK';
  }

  async isEventProcessed(eventId: string): Promise<boolean> {
    return (await this.redis.exists(`tg:evt:done:${eventId}`)) > 0;
  }

  async markEventProcessed(
    eventId: string,
    ttlSec = DEFAULT_DEDUP_TTL_SEC,
  ): Promise<void> {
    await this.redis.set(`tg:evt:done:${eventId}`, '1', 'EX', ttlSec);
  }
}
