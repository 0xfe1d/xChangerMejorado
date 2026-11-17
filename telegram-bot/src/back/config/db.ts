import { Pool, QueryResultRow } from 'pg';
import { env } from './env';

export interface Queryable {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

const BOT_SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS telegram_accounts (
  telegram_user_id   TEXT PRIMARY KEY,
  chat_id            TEXT NOT NULL,
  core_user_id       TEXT NOT NULL,
  channel_session_id TEXT NOT NULL,
  refresh_token_enc  TEXT NOT NULL,
  locale             TEXT NOT NULL DEFAULT 'es',
  linked_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_telegram_accounts_core_user_id
  ON telegram_accounts (core_user_id);

CREATE INDEX IF NOT EXISTS idx_telegram_accounts_session_id
  ON telegram_accounts (channel_session_id);
`;

let pool: Pool | null = null;

/** Devuelve el pool compartido hacia PostgreSQL (bot-db). */
export function getBotDb(): Pool {
  if (!pool) {
    if (!env.BOT_DATABASE_URL) {
      throw new Error('BOT_DATABASE_URL es obligatoria cuando se accede a bot-db');
    }
    pool = new Pool({
      connectionString: env.BOT_DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    pool.on('error', (err) => console.error('[bot-db]', err.message));
  }
  return pool;
}

/** Crea de forma idempotente la tabla `telegram_accounts` e índices asociados (§6.2). */
export async function initBotDatabase(db: Queryable = getBotDb()): Promise<void> {
  await db.query(BOT_SCHEMA_DDL);
}

/** Cierra limpiamente el pool de `bot-db`. */
export async function closeBotDb(): Promise<void> {
  if (pool) {
    await pool.end().catch(() => undefined);
    pool = null;
  }
}
