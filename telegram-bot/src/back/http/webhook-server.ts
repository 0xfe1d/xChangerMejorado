import crypto from 'crypto';
import http, { IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { RedisDedupStore } from '../storage/redis-stores';

const DEFAULT_MAX_BODY_BYTES = 1_048_576; // 1 MB (§12.2)

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; first_name?: string; last_name?: string; username?: string };
    chat: { id: number; type: 'private' | 'group' | 'supergroup' | 'channel' };
    text?: string;
  };
  callback_query?: {
    id: string;
    from: { id: number; first_name?: string; last_name?: string; username?: string };
    message?: { message_id: number; chat: { id: number; type: string } };
    data?: string;
  };
  [key: string]: unknown;
}

export interface HealthzStatus {
  status: 'ok' | 'degraded';
  redis: 'up' | 'down';
  core: 'up' | 'down';
  consumerLagMs: number;
}

export interface BotHttpServerConfig {
  webhookSecret: string;
  dedupStore?: Pick<RedisDedupStore, 'markTelegramUpdateOnce'>;
  onUpdate: (update: TelegramUpdate) => Promise<void> | void;
  checkRedis?: () => Promise<boolean>;
  checkCore?: () => Promise<boolean>;
  getConsumerLagMs?: () => number;
  maxBodyBytes?: number;
}

class PayloadTooLargeError extends Error {}

function verifySecretToken(received: string | undefined, expected: string): boolean {
  if (!received || !expected) return false;
  const a = Buffer.from(received, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBodyWithLimit(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        req.pause();
        reject(new PayloadTooLargeError('Cuerpo demasiado grande'));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });

    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

function parseTelegramUpdate(raw: string): TelegramUpdate | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { update_id?: unknown }).update_id === 'number' &&
      Number.isInteger((parsed as { update_id: number }).update_id)
    ) {
      return parsed as TelegramUpdate;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Servidor HTTP del microservicio `telegram-bot` (§6.2, §9.9, §12.2):
 *  · `POST /telegram/webhook` (`EP-B-01`): valida secret token, deduplica `update_id`
 *    en Redis (`tg:upd:*`) y responde `200` inmediato procesando el update en segundo plano.
 *  · `GET /healthz` (`EP-B-02`): estado de Redis, Core y lag del consumidor de eventos.
 */
export class BotHttpServer {
  private readonly webhookSecret: string;
  private readonly dedupStore?: Pick<RedisDedupStore, 'markTelegramUpdateOnce'>;
  private readonly onUpdate: (update: TelegramUpdate) => Promise<void> | void;
  private readonly checkRedis: () => Promise<boolean>;
  private readonly checkCore: () => Promise<boolean>;
  private readonly getConsumerLagMs: () => number;
  private readonly maxBodyBytes: number;

  private readonly inFlightUpdates = new Set<Promise<void>>();
  private server: Server | null = null;

  constructor(config: BotHttpServerConfig) {
    this.webhookSecret = config.webhookSecret;
    this.dedupStore = config.dedupStore;
    this.onUpdate = config.onUpdate;
    this.checkRedis = config.checkRedis ?? (async () => true);
    this.checkCore = config.checkCore ?? (async () => true);
    this.getConsumerLagMs = config.getConsumerLagMs ?? (() => 0);
    this.maxBodyBytes = config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  }

  async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;

      if (req.method === 'GET' && pathname === '/healthz') {
        await this.handleHealthz(res);
        return;
      }

      if (req.method === 'POST' && pathname === '/telegram/webhook') {
        await this.handleWebhook(req, res);
        return;
      }

      sendJson(res, 404, { error: 'Ruta no encontrada', code: 'NOT_FOUND' });
    } catch (err) {
      console.error('[telegram-bot:http] error atendiendo petición:', err);
      sendJson(res, 500, { error: 'Error interno', code: 'INTERNAL_ERROR' });
    }
  }

  private async handleHealthz(res: ServerResponse): Promise<void> {
    const [redisOk, coreOk] = await Promise.all([
      this.checkRedis().catch(() => false),
      this.checkCore().catch(() => false),
    ]);

    const body: HealthzStatus = {
      status: redisOk && coreOk ? 'ok' : 'degraded',
      redis: redisOk ? 'up' : 'down',
      core: coreOk ? 'up' : 'down',
      consumerLagMs: this.getConsumerLagMs(),
    };
    sendJson(res, 200, body);
  }

  private async handleWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const secretHeader = req.headers['x-telegram-bot-api-secret-token'];
    const receivedSecret = Array.isArray(secretHeader) ? secretHeader[0] : secretHeader;

    if (!verifySecretToken(receivedSecret, this.webhookSecret)) {
      sendJson(res, 401, { error: 'No autorizado', code: 'WEBHOOK_UNAUTHORIZED' });
      return;
    }

    let rawBody: string;
    try {
      rawBody = await readBodyWithLimit(req, this.maxBodyBytes);
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        sendJson(res, 413, { error: 'Cuerpo demasiado grande', code: 'PAYLOAD_TOO_LARGE' });
        return;
      }
      sendJson(res, 400, { error: 'Error leyendo cuerpo', code: 'VALIDATION_ERROR' });
      return;
    }

    const update = parseTelegramUpdate(rawBody);
    if (!update) {
      sendJson(res, 400, { error: 'Update inválido', code: 'VALIDATION_ERROR' });
      return;
    }

    if (this.dedupStore) {
      const firstTime = await this.dedupStore.markTelegramUpdateOnce(update.update_id);
      if (!firstTime) {
        sendJson(res, 200, { ok: true, duplicate: true });
        return;
      }
    }

    // §6.2 / §9.9: responder 200 de inmediato y procesar en segundo plano
    sendJson(res, 200, { ok: true });

    const job = Promise.resolve()
      .then(() => this.onUpdate(update))
      .catch((err) => {
        console.error(`[telegram-bot:webhook] error procesando update ${update.update_id}:`, err);
      })
      .finally(() => {
        this.inFlightUpdates.delete(job);
      });

    this.inFlightUpdates.add(job);
  }

  listen(port: number, host = '0.0.0.0'): Promise<number> {
    if (this.server) {
      throw new Error('El servidor HTTP ya está escuchando');
    }
    const srv = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });
    this.server = srv;

    return new Promise((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(port, host, () => {
        srv.removeListener('error', reject);
        resolve((srv.address() as AddressInfo).port);
      });
    });
  }

  async drain(): Promise<void> {
    if (this.inFlightUpdates.size > 0) {
      await Promise.allSettled([...this.inFlightUpdates]);
    }
  }

  async close(): Promise<void> {
    await this.drain();
    const srv = this.server;
    this.server = null;
    if (!srv) return;
    await new Promise<void>((resolve, reject) => {
      srv.close((err) => (err ? reject(err) : resolve()));
    });
  }
}
