import { Queryable } from '../config/db';
import { TokenCipher } from '../crypto/token-cipher';

export interface UpsertTelegramAccountInput {
  telegramUserId: string;
  chatId: string;
  coreUserId: string;
  channelSessionId: string;
  refreshToken: string;
  locale?: string;
}

export interface TelegramAccountSummary {
  telegramUserId: string;
  chatId: string;
  coreUserId: string;
  channelSessionId: string;
  locale: string;
  linkedAt: Date;
}

export interface TelegramAccountRecord extends TelegramAccountSummary {
  refreshToken: string;
}

interface AccountRow {
  telegram_user_id: string;
  chat_id: string;
  core_user_id: string;
  channel_session_id: string;
  refresh_token_enc: string;
  locale: string;
  linked_at: Date | string;
}

const SELECT_SUMMARY_COLS =
  'telegram_user_id, chat_id, core_user_id, channel_session_id, locale, linked_at';

const SELECT_FULL_COLS =
  'telegram_user_id, chat_id, core_user_id, channel_session_id, refresh_token_enc, locale, linked_at';

function mapSummary(row: Omit<AccountRow, 'refresh_token_enc'>): TelegramAccountSummary {
  return {
    telegramUserId: row.telegram_user_id,
    chatId: row.chat_id,
    coreUserId: row.core_user_id,
    channelSessionId: row.channel_session_id,
    locale: row.locale,
    linkedAt: row.linked_at instanceof Date ? row.linked_at : new Date(row.linked_at),
  };
}

/**
 * Repositorio de la tabla `telegram_accounts` en `bot-db`.
 * Encapsula las consultas SQL parametrizadas y el cifrado transparente del `refreshToken`.
 */
export class TelegramAccountsRepository {
  constructor(
    private readonly db: Queryable,
    private readonly cipher: TokenCipher,
  ) {}

  async upsertAccount(input: UpsertTelegramAccountInput): Promise<void> {
    const encryptedToken = this.cipher.encrypt(input.refreshToken, input.telegramUserId);
    const locale = input.locale ?? 'es';

    await this.db.query(
      `INSERT INTO telegram_accounts (
        telegram_user_id,
        chat_id,
        core_user_id,
        channel_session_id,
        refresh_token_enc,
        locale,
        linked_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (telegram_user_id) DO UPDATE SET
        chat_id = EXCLUDED.chat_id,
        core_user_id = EXCLUDED.core_user_id,
        channel_session_id = EXCLUDED.channel_session_id,
        refresh_token_enc = EXCLUDED.refresh_token_enc,
        locale = EXCLUDED.locale,
        linked_at = NOW()`,
      [
        input.telegramUserId,
        input.chatId,
        input.coreUserId,
        input.channelSessionId,
        encryptedToken,
        locale,
      ],
    );
  }

  async findByTelegramUserId(telegramUserId: string): Promise<TelegramAccountRecord | null> {
    const res = await this.db.query<AccountRow>(
      `SELECT ${SELECT_FULL_COLS}
       FROM telegram_accounts
       WHERE telegram_user_id = $1`,
      [telegramUserId],
    );
    const row = res.rows[0];
    if (!row) return null;

    return {
      ...mapSummary(row),
      refreshToken: this.cipher.decrypt(row.refresh_token_enc, row.telegram_user_id),
    };
  }

  async findByCoreUserId(coreUserId: string): Promise<TelegramAccountSummary | null> {
    const res = await this.db.query<Omit<AccountRow, 'refresh_token_enc'>>(
      `SELECT ${SELECT_SUMMARY_COLS}
       FROM telegram_accounts
       WHERE core_user_id = $1
       ORDER BY linked_at DESC
       LIMIT 1`,
      [coreUserId],
    );
    return res.rows[0] ? mapSummary(res.rows[0]) : null;
  }

  /** Consulta en lote para filtrar `audience` de `xchanger:events` sin fugas ni N+1. */
  async findByCoreUserIds(coreUserIds: string[]): Promise<TelegramAccountSummary[]> {
    const uniqueIds = [...new Set(coreUserIds.filter(Boolean))];
    if (uniqueIds.length === 0) return [];

    const res = await this.db.query<Omit<AccountRow, 'refresh_token_enc'>>(
      `SELECT ${SELECT_SUMMARY_COLS}
       FROM telegram_accounts
       WHERE core_user_id = ANY($1::text[])`,
      [uniqueIds],
    );
    return res.rows.map(mapSummary);
  }

  async updateRotatedSession(
    telegramUserId: string,
    channelSessionId: string,
    newRefreshToken: string,
  ): Promise<boolean> {
    const encryptedToken = this.cipher.encrypt(newRefreshToken, telegramUserId);
    const res = await this.db.query(
      `UPDATE telegram_accounts
       SET channel_session_id = $2,
           refresh_token_enc = $3
       WHERE telegram_user_id = $1`,
      [telegramUserId, channelSessionId, encryptedToken],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async deleteByTelegramUserId(telegramUserId: string): Promise<boolean> {
    const res = await this.db.query(
      'DELETE FROM telegram_accounts WHERE telegram_user_id = $1',
      [telegramUserId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async deleteByCoreUserId(coreUserId: string): Promise<number> {
    const res = await this.db.query(
      'DELETE FROM telegram_accounts WHERE core_user_id = $1',
      [coreUserId],
    );
    return res.rowCount ?? 0;
  }

  async deleteBySessionId(channelSessionId: string): Promise<boolean> {
    const res = await this.db.query(
      'DELETE FROM telegram_accounts WHERE channel_session_id = $1',
      [channelSessionId],
    );
    return (res.rowCount ?? 0) > 0;
  }
}
