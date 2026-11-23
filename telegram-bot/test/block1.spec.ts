import crypto from 'crypto';
import { initBotDatabase, Queryable } from '../src/back/config/db';
import { TokenCipher } from '../src/back/crypto/token-cipher';
import { TelegramAccountsRepository } from '../src/back/storage/accounts.repo';
import {
  RedisCallbackStore,
  RedisDedupStore,
  RedisLike,
  RedisPendingLinkStore,
  RedisStateStore,
} from '../src/back/storage/redis-stores';

class InMemoryRedis implements RedisLike {
  readonly data = new Map<string, { value: string; ttlSec: number }>();

  private assertTgPrefix(key: string): void {
    if (!key.startsWith('tg:')) {
      throw new Error(`Clave Redis fuera de la ACL tg:*: ${key}`);
    }
  }

  async get(key: string): Promise<string | null> {
    this.assertTgPrefix(key);
    return this.data.get(key)?.value ?? null;
  }

  async set(
    key: string,
    value: string,
    _secondsToken: 'EX',
    seconds: number,
    nxToken?: 'NX',
  ): Promise<string | null> {
    this.assertTgPrefix(key);
    if (nxToken === 'NX' && this.data.has(key)) {
      return null;
    }
    this.data.set(key, { value, ttlSec: seconds });
    return 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const k of keys) {
      this.assertTgPrefix(k);
      if (this.data.delete(k)) removed += 1;
    }
    return removed;
  }

  async exists(...keys: string[]): Promise<number> {
    let count = 0;
    for (const k of keys) {
      this.assertTgPrefix(k);
      if (this.data.has(k)) count += 1;
    }
    return count;
  }
}

interface StoredAccountRow {
  telegram_user_id: string;
  chat_id: string;
  core_user_id: string;
  channel_session_id: string;
  refresh_token_enc: string;
  locale: string;
  linked_at: Date;
}

class InMemoryBotDb implements Queryable {
  ddlExecuted: string[] = [];
  readonly rows = new Map<string, StoredAccountRow>();

  async query<T>(
    text: string,
    params: unknown[] = [],
  ): Promise<{ rows: T[]; rowCount: number | null }> {
    const sql = text.trim();

    if (sql.startsWith('CREATE TABLE') || sql.startsWith('CREATE INDEX')) {
      this.ddlExecuted.push(sql);
      return { rows: [], rowCount: 0 };
    }

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

    if (sql.includes('WHERE core_user_id = $1') && sql.startsWith('SELECT')) {
      const target = params[0] as string;
      const found = [...this.rows.values()].find((r) => r.core_user_id === target);
      return { rows: (found ? [found] : []) as unknown as T[], rowCount: found ? 1 : 0 };
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
      const deleted = this.rows.delete(params[0] as string);
      return { rows: [], rowCount: deleted ? 1 : 0 };
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

    throw new Error(`Consulta SQL no soportada en doble de prueba: ${sql}`);
  }
}

describe('Bloque 1: Cifrado AES-256-GCM (TokenCipher)', () => {
  const validKeyBase64 = crypto.randomBytes(32).toString('base64');
  const validKeyHex = crypto.randomBytes(32).toString('hex');

  it('cifra y descifra correctamente con clave base64 o hex y genera IV único cada vez', () => {
    const cipherB64 = new TokenCipher(validKeyBase64);
    const cipherHex = new TokenCipher(validKeyHex);
    const token = 'refresh_opaque_43_chars_example_1234567890';

    const enc1 = cipherB64.encrypt(token, '10001');
    const enc2 = cipherB64.encrypt(token, '10001');

    expect(enc1).toMatch(/^v1:/);
    expect(enc1).not.toEqual(enc2);
    expect(enc1).not.toContain(token);
    expect(cipherB64.decrypt(enc1, '10001')).toBe(token);
    expect(cipherB64.decrypt(enc2, '10001')).toBe(token);

    const encHex = cipherHex.encrypt(token, '10002');
    expect(cipherHex.decrypt(encHex, '10002')).toBe(token);
  });

  it('rechaza descifrar si cambia el telegramUserId (protección AAD) o si se altera el payload', () => {
    const cipher = new TokenCipher(validKeyBase64);
    const encrypted = cipher.encrypt('secret-refresh-token', '11111');

    expect(() => cipher.decrypt(encrypted, '22222')).toThrow();

    const parts = encrypted.split(':');
    const tamperedCipher = `${parts[0]}:${parts[1]}:${parts[2]}:AAAA`;
    expect(() => cipher.decrypt(tamperedCipher, '11111')).toThrow();
  });

  it('rechaza claves vacías o de longitud distinta a 32 bytes', () => {
    expect(() => new TokenCipher('')).toThrow();
    expect(() => new TokenCipher(crypto.randomBytes(16).toString('base64'))).toThrow();
    expect(() => new TokenCipher('no-es-una-clave-valida!!')).toThrow();
  });
});

describe('Bloque 1: Almacenes Redis bajo prefijo tg:*', () => {
  it('RedisStateStore guarda, lee y limpia estado con TTL de 15 min', async () => {
    const redis = new InMemoryRedis();
    const store = new RedisStateStore(redis);

    await store.set('chat_1', { step: 'BUSCAR:ELEGIR_GRUPO', data: { asignaturaId: 'asig_1' } });
    expect(redis.data.get('tg:state:chat_1')?.ttlSec).toBe(900);
    expect(await store.get('chat_1')).toEqual({
      step: 'BUSCAR:ELEGIR_GRUPO',
      data: { asignaturaId: 'asig_1' },
    });

    await store.clear('chat_1');
    expect(await store.get('chat_1')).toBeNull();
  });

  it('RedisCallbackStore genera claves cortas < 64 bytes y recupera el payload', async () => {
    const redis = new InMemoryRedis();
    const store = new RedisCallbackStore(redis);
    const payload = { action: 'offer:accept', data: { offerId: 'cm1234567890abcdef123456' } };

    const key = await store.encode(payload);
    expect(key).toMatch(/^cb:[0-9a-f]{16}$/);
    expect(Buffer.byteLength(key, 'utf8')).toBeLessThan(64);
    expect(redis.data.get(`tg:${key}`)?.ttlSec).toBe(86400);

    expect(await store.decode(key)).toEqual(payload);
    expect(await store.decode('invalid-key')).toBeNull();
  });

  it('RedisPendingLinkStore guarda, consulta y consume la solicitud de vinculación', async () => {
    const redis = new InMemoryRedis();
    const store = new RedisPendingLinkStore(redis);

    await store.save('998877', {
      deviceCode: 'dev_abc',
      userCode: 'ABCD-2345',
      chatId: '998877',
      displayName: 'Ana Pérez',
      createdAt: '2026-11-17T10:00:00Z',
    });

    expect(redis.data.get('tg:link:998877')?.ttlSec).toBe(600);
    const consumed = await store.consume('998877');
    expect(consumed?.deviceCode).toBe('dev_abc');
    expect(await store.get('998877')).toBeNull();
  });

  it('RedisDedupStore deduplica update_id de Telegram y event.id del stream', async () => {
    const redis = new InMemoryRedis();
    const store = new RedisDedupStore(redis);

    expect(await store.markTelegramUpdateOnce(100500)).toBe(true);
    expect(await store.markTelegramUpdateOnce(100500)).toBe(false);

    expect(await store.isEventProcessed('01JC9Z123')).toBe(false);
    await store.markEventProcessed('01JC9Z123');
    expect(await store.isEventProcessed('01JC9Z123')).toBe(true);
  });
});

describe('Bloque 1: Persistencia en bot-db (TelegramAccountsRepository)', () => {
  const key = crypto.randomBytes(32).toString('base64');

  it('inicializa esquema, cifra refreshToken al guardar y descifra al leer', async () => {
    const db = new InMemoryBotDb();
    await initBotDatabase(db);
    expect(db.ddlExecuted[0]).toContain('CREATE TABLE IF NOT EXISTS telegram_accounts');

    const repo = new TelegramAccountsRepository(db, new TokenCipher(key));
    const plainRefresh = 'q3V_super_secret_refresh_token_43_bytes_xyz';

    await repo.upsertAccount({
      telegramUserId: '55123',
      chatId: '55123',
      coreUserId: 'ck_ana',
      channelSessionId: 'cs_1',
      refreshToken: plainRefresh,
    });

    const rawRow = db.rows.get('55123');
    expect(rawRow).toBeDefined();
    expect(rawRow!.refresh_token_enc).not.toBe(plainRefresh);
    expect(rawRow!.refresh_token_enc).toMatch(/^v1:/);

    const record = await repo.findByTelegramUserId('55123');
    expect(record?.coreUserId).toBe('ck_ana');
    expect(record?.refreshToken).toBe(plainRefresh);
  });

  it('soporta consulta batch por coreUserIds, rotación de sesión y borrados', async () => {
    const db = new InMemoryBotDb();
    const repo = new TelegramAccountsRepository(db, new TokenCipher(key));

    await repo.upsertAccount({
      telegramUserId: '101',
      chatId: '101',
      coreUserId: 'ck_1',
      channelSessionId: 'cs_1',
      refreshToken: 'rt_1',
    });
    await repo.upsertAccount({
      telegramUserId: '102',
      chatId: '102',
      coreUserId: 'ck_2',
      channelSessionId: 'cs_2',
      refreshToken: 'rt_2',
    });

    const matches = await repo.findByCoreUserIds(['ck_1', 'ck_999', 'ck_1']);
    expect(matches).toHaveLength(1);
    expect(matches[0].telegramUserId).toBe('101');

    expect(await repo.updateRotatedSession('101', 'cs_1b', 'rt_1_rotated')).toBe(true);
    const updated = await repo.findByTelegramUserId('101');
    expect(updated?.channelSessionId).toBe('cs_1b');
    expect(updated?.refreshToken).toBe('rt_1_rotated');

    expect(await repo.deleteBySessionId('cs_1b')).toBe(true);
    expect(await repo.findByTelegramUserId('101')).toBeNull();

    expect(await repo.deleteByCoreUserId('ck_2')).toBe(1);
    expect(await repo.findByCoreUserId('ck_2')).toBeNull();
  });
});
