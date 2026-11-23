const DEFAULT_API_BASE_URL = 'https://api.telegram.org';
const DEFAULT_PER_CHAT_INTERVAL_MS = 1_000; // ~1 msg/s por chat (§6.2)
const DEFAULT_GLOBAL_MAX_PER_SEC = 30; // ~30 msg/s globales (§6.2)
const DEFAULT_MAX_RETRIES = 3;

export class TelegramRateLimitError extends Error {
  constructor(
    public readonly retryAfterSec: number,
    message = `Telegram API 429: reintentar en ${retryAfterSec}s`,
  ) {
    super(message);
    this.name = 'TelegramRateLimitError';
  }
}

export interface OutboundQueueConfig {
  botToken?: string;
  apiBaseUrl?: string;
  perChatIntervalMs?: number;
  globalMaxPerSec?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
  sleepFn?: (ms: number) => Promise<void>;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function extractRetryAfterSec(err: unknown): number | null {
  if (err instanceof TelegramRateLimitError) {
    return Math.max(1, err.retryAfterSec);
  }
  if (typeof err === 'object' && err !== null) {
    const record = err as Record<string, unknown>;
    if (typeof record.retryAfterSec === 'number' && Number.isFinite(record.retryAfterSec)) {
      return Math.max(1, Math.ceil(record.retryAfterSec));
    }
    const params = record.parameters as Record<string, unknown> | undefined;
    if (params && typeof params.retry_after === 'number' && Number.isFinite(params.retry_after)) {
      return Math.max(1, Math.ceil(params.retry_after));
    }
  }
  return null;
}

/**
 * Cola de salida hacia la Bot API de Telegram (§6.2, §6.8):
 *  · Limita a 1 mensaje/s por chat (FIFO por `chatId`) y 30 mensajes/s globales.
 *  · Pausa y reintenta automáticamente cuando Telegram responde 429 con `retry_after`.
 */
export class OutboundQueue {
  private readonly botToken: string;
  private readonly apiBaseUrl: string;
  private readonly perChatIntervalMs: number;
  private readonly globalMaxPerSec: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly nowMs: () => number;
  private readonly sleepFn: (ms: number) => Promise<void>;

  private readonly chainByChat = new Map<string, Promise<unknown>>();
  private readonly nextChatAvailableMs = new Map<string, number>();
  private readonly recentGlobalTimestamps: number[] = [];
  private globalBlockedUntilMs = 0;
  private slotMutex: Promise<void> = Promise.resolve();

  constructor(config: OutboundQueueConfig = {}) {
    this.botToken = config.botToken ?? '';
    this.apiBaseUrl = (config.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/, '');
    this.perChatIntervalMs = config.perChatIntervalMs ?? DEFAULT_PER_CHAT_INTERVAL_MS;
    this.globalMaxPerSec = config.globalMaxPerSec ?? DEFAULT_GLOBAL_MAX_PER_SEC;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.nowMs = config.nowMs ?? (() => Date.now());
    this.sleepFn = config.sleepFn ?? defaultSleep;
  }

  /** Encola cualquier envío al `chatId` garantizando orden por chat, rate limit y retry ante 429. */
  enqueue<T>(chatId: string | number, task: () => Promise<T>): Promise<T> {
    const key = String(chatId);
    const prev = this.chainByChat.get(key) ?? Promise.resolve();

    const next = prev.then(
      () => this.runWithRateLimit(key, task),
      () => this.runWithRateLimit(key, task),
    );

    const cleanup = next
      .catch(() => undefined)
      .finally(() => {
        if (this.chainByChat.get(key) === cleanup) {
          this.chainByChat.delete(key);
        }
      });
    this.chainByChat.set(key, cleanup);
    return next;
  }

  private pruneGlobalWindow(now: number): void {
    const cutoff = now - 1_000;
    while (this.recentGlobalTimestamps.length > 0 && this.recentGlobalTimestamps[0] <= cutoff) {
      this.recentGlobalTimestamps.shift();
    }
  }

  private acquireSlot(chatId: string): Promise<void> {
    const attempt = this.slotMutex.then(() => this.waitForSlot(chatId));
    this.slotMutex = attempt.catch(() => undefined);
    return attempt;
  }

  private async waitForSlot(chatId: string): Promise<void> {
    for (;;) {
      const now = this.nowMs();
      const chatReadyAt = this.nextChatAvailableMs.get(chatId) ?? 0;
      let waitUntil = Math.max(now, this.globalBlockedUntilMs, chatReadyAt);

      this.pruneGlobalWindow(waitUntil);
      if (this.recentGlobalTimestamps.length >= this.globalMaxPerSec) {
        waitUntil = Math.max(waitUntil, this.recentGlobalTimestamps[0] + 1_000);
      }

      const delay = waitUntil - now;
      if (delay > 0) {
        await this.sleepFn(delay);
        continue;
      }

      this.recentGlobalTimestamps.push(now);
      this.nextChatAvailableMs.set(chatId, now + this.perChatIntervalMs);
      return;
    }
  }

  private async runWithRateLimit<T>(chatId: string, task: () => Promise<T>): Promise<T> {
    let attempt = 0;

    for (;;) {
      await this.acquireSlot(chatId);
      try {
        return await task();
      } catch (err) {
        const retryAfterSec = extractRetryAfterSec(err);
        if (retryAfterSec !== null && attempt < this.maxRetries) {
          attempt += 1;
          const retryDelayMs = retryAfterSec * 1_000;
          this.globalBlockedUntilMs = Math.max(
            this.globalBlockedUntilMs,
            this.nowMs() + retryDelayMs,
          );
          await this.sleepFn(retryDelayMs);
          continue;
        }
        throw err;
      }
    }
  }

  /** Ejecuta un método de la Bot API de Telegram pasando por la cola de salida. */
  async callTelegramApi<T = unknown>(
    chatId: string | number,
    method: string,
    payload: Record<string, unknown>,
  ): Promise<T> {
    if (!this.botToken) {
      throw new Error('TELEGRAM_BOT_TOKEN es obligatorio para enviar peticiones a Telegram');
    }

    return this.enqueue(chatId, async () => {
      const url = `${this.apiBaseUrl}/bot${this.botToken}/${method}`;
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const body = (await res.json().catch(() => null)) as TelegramApiResponse<T> | null;
      if (res.status === 429 || body?.error_code === 429) {
        const retryAfter = body?.parameters?.retry_after ?? 1;
        throw new TelegramRateLimitError(retryAfter, body?.description);
      }

      if (!res.ok || !body?.ok) {
        throw new Error(body?.description ?? `Error Telegram API (${res.status}) en ${method}`);
      }

      return body.result as T;
    });
  }

  sendMessage(
    chatId: string | number,
    text: string,
    extra: Record<string, unknown> = {},
  ): Promise<unknown> {
    return this.callTelegramApi(chatId, 'sendMessage', {
      chat_id: chatId,
      text,
      ...extra,
    });
  }

  /** Borra mensajes con códigos OTP/XOTP tras leerlos (`RF-TGB-13`). */
  deleteMessage(chatId: string | number, messageId: number): Promise<unknown> {
    return this.callTelegramApi(chatId, 'deleteMessage', {
      chat_id: chatId,
      message_id: messageId,
    });
  }

  answerCallbackQuery(
    chatId: string | number,
    callbackQueryId: string,
    text?: string,
  ): Promise<unknown> {
    return this.callTelegramApi(chatId, 'answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      ...(text !== undefined ? { text } : {}),
    });
  }
}
