import os from 'os';
import { RedisDedupStore } from '../storage/redis-stores';
import { BotEventDispatcher, CoreEventEnvelope } from './event-dispatcher';

export const EVENTS_STREAM = 'xchanger:events';
export const TELEGRAM_CONSUMER_GROUP = 'telegram-bot';
export const MAX_EVENT_DELIVERIES = 5;
export const DEFAULT_CLAIM_IDLE_MS = 30_000;
const READ_COUNT = 50;
const BLOCK_MS = 2_000;
const ERROR_BACKOFF_MS = 1_000;

export type StreamEntry = [string, string[]];

/** Subconjunto mínimo de Redis Streams compatible con `ioredis` y dobles en memoria. */
export interface RedisStreamClient {
  xgroup(
    command: 'CREATE',
    stream: string,
    group: string,
    id: string,
    mkstream: 'MKSTREAM',
  ): Promise<unknown>;
  xreadgroup(
    groupToken: 'GROUP',
    group: string,
    consumer: string,
    countToken: 'COUNT',
    count: number,
    streamsToken: 'STREAMS',
    stream: string,
    id: string,
  ): Promise<unknown>;
  xreadgroup(
    groupToken: 'GROUP',
    group: string,
    consumer: string,
    countToken: 'COUNT',
    count: number,
    blockToken: 'BLOCK',
    blockMs: number,
    streamsToken: 'STREAMS',
    stream: string,
    id: string,
  ): Promise<unknown>;
  xautoclaim(
    stream: string,
    group: string,
    consumer: string,
    minIdleTime: number,
    start: string,
    countToken: 'COUNT',
    count: number,
  ): Promise<unknown>;
  xack(stream: string, group: string, id: string): Promise<number>;
  disconnect?(): void;
}

export interface EventStreamConsumerConfig {
  redis: RedisStreamClient;
  /** Fábrica opcional de conexión dedicada bloqueante (`BLOCK`) para `start()`. */
  createBlockingClient?: () => RedisStreamClient;
  dedupStore: RedisDedupStore;
  dispatcher: BotEventDispatcher;
  group?: string;
  stream?: string;
  consumerName?: string;
  claimIdleMs?: number;
  nowMs?: () => number;
}

function parseEnvelope(fields: string[]): CoreEventEnvelope | null {
  const idx = fields.indexOf('event');
  if (idx < 0 || idx + 1 >= fields.length) return null;
  try {
    const parsed = JSON.parse(fields[idx + 1]) as CoreEventEnvelope;
    if (!parsed || typeof parsed.id !== 'string' || typeof parsed.type !== 'string') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function extractEntries(raw: unknown): StreamEntry[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const firstStream = raw[0];
  if (!Array.isArray(firstStream) || !Array.isArray(firstStream[1])) return [];
  return firstStream[1].filter(
    (e): e is StreamEntry => Array.isArray(e) && typeof e[0] === 'string' && Array.isArray(e[1]),
  );
}

/**
 * Consumidor de `xchanger:events` para el grupo `telegram-bot` (§6.2, §6.8, §11):
 *  · Lee por `XREADGROUP` y recupera mensajes pendientes con `XAUTOCLAIM`.
 *  · Deduplica por `event.id` (`tg:evt:done:*`) y limita reintentos (`tg:evt:tries:*`).
 *  · Expone `getConsumerLagMs()` para el endpoint de salud `/healthz`.
 */
export class RedisEventStreamConsumer {
  private readonly redis: RedisStreamClient;
  private readonly createBlockingClient?: () => RedisStreamClient;
  private readonly dedupStore: RedisDedupStore;
  private readonly dispatcher: BotEventDispatcher;
  private readonly stream: string;
  private readonly group: string;
  private readonly consumerName: string;
  private readonly claimIdleMs: number;
  private readonly nowMs: () => number;

  private blockingClient: RedisStreamClient | null = null;
  private stopped = true;
  private loopPromise: Promise<void> | null = null;
  private lastConsumerLagMs = 0;

  constructor(config: EventStreamConsumerConfig) {
    this.redis = config.redis;
    this.createBlockingClient = config.createBlockingClient;
    this.dedupStore = config.dedupStore;
    this.dispatcher = config.dispatcher;
    this.stream = config.stream ?? EVENTS_STREAM;
    this.group = config.group ?? TELEGRAM_CONSUMER_GROUP;
    this.consumerName = config.consumerName ?? `${os.hostname()}-${process.pid}`;
    this.claimIdleMs = config.claimIdleMs ?? DEFAULT_CLAIM_IDLE_MS;
    this.nowMs = config.nowMs ?? (() => Date.now());
  }

  getConsumerLagMs(): number {
    return this.lastConsumerLagMs;
  }

  async ensureGroup(): Promise<void> {
    try {
      await this.redis.xgroup('CREATE', this.stream, this.group, '$', 'MKSTREAM');
    } catch (err) {
      if (!String((err as Error).message).includes('BUSYGROUP')) {
        throw err;
      }
    }
  }

  private async handleEntry(entry: StreamEntry): Promise<boolean> {
    const [, fields] = entry;
    const event = parseEnvelope(fields);
    if (!event) {
      return true; // Mensaje malformado: confirmar para no atascar el stream
    }

    if (await this.dedupStore.isEventProcessed(event.id)) {
      return true;
    }

    try {
      await this.dispatcher.dispatch(event);
      await this.dedupStore.markEventProcessed(event.id);
      await this.dedupStore.clearEventTries(event.id);

      const occurredMs = Date.parse(event.occurredAt);
      if (Number.isFinite(occurredMs)) {
        this.lastConsumerLagMs = Math.max(0, this.nowMs() - occurredMs);
      }
      return true;
    } catch (err) {
      const tries = await this.dedupStore.incrementEventTries(event.id);
      console.error(
        `[telegram-bot:events] fallo ${tries}/${MAX_EVENT_DELIVERIES} en ${event.type} (${event.id}):`,
        (err as Error).message,
      );
      return tries >= MAX_EVENT_DELIVERIES;
    }
  }

  private async processEntries(entries: StreamEntry[]): Promise<number> {
    for (const entry of entries) {
      const shouldAck = await this.handleEntry(entry);
      if (shouldAck) {
        await this.redis.xack(this.stream, this.group, entry[0]);
      }
    }
    return entries.length;
  }

  /** Drena entradas nuevas y reclama pendientes (útil al arrancar y en tests). */
  async processAvailable(): Promise<number> {
    await this.ensureGroup();
    let total = 0;

    for (;;) {
      const raw = await this.redis.xreadgroup(
        'GROUP',
        this.group,
        this.consumerName,
        'COUNT',
        READ_COUNT,
        'STREAMS',
        this.stream,
        '>',
      );
      const entries = extractEntries(raw);
      if (entries.length === 0) break;
      total += await this.processEntries(entries);
    }

    return total + (await this.reclaimStale(0));
  }

  /** Reintenta eventos huérfanos o fallidos que llevan más de `minIdleMs` pendientes. */
  async reclaimStale(minIdleMs = this.claimIdleMs): Promise<number> {
    const raw = (await this.redis.xautoclaim(
      this.stream,
      this.group,
      this.consumerName,
      minIdleMs,
      '0-0',
      'COUNT',
      READ_COUNT,
    )) as [string, unknown] | null;

    const rawEntries = Array.isArray(raw?.[1]) ? raw[1] : [];
    const entries = rawEntries.filter(
      (e): e is StreamEntry => Array.isArray(e) && typeof e[0] === 'string' && Array.isArray(e[1]),
    );
    if (entries.length === 0) return 0;
    return this.processEntries(entries);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.blockingClient = this.createBlockingClient ? this.createBlockingClient() : this.redis;
    let lastClaimMs = this.nowMs();

    this.loopPromise = (async () => {
      await this.ensureGroup();
      while (!this.stopped) {
        try {
          const raw = await this.blockingClient!.xreadgroup(
            'GROUP',
            this.group,
            this.consumerName,
            'COUNT',
            READ_COUNT,
            'BLOCK',
            BLOCK_MS,
            'STREAMS',
            this.stream,
            '>',
          );
          const entries = extractEntries(raw);
          if (entries.length > 0) {
            await this.processEntries(entries);
          }

          if (this.nowMs() - lastClaimMs >= this.claimIdleMs) {
            lastClaimMs = this.nowMs();
            await this.reclaimStale();
          }
        } catch (err) {
          if (this.stopped) break;
          const message = (err as Error).message;
          if (message.includes('NOGROUP')) {
            await this.ensureGroup().catch(() => undefined);
          } else {
            console.error('[telegram-bot:events]', message);
          }
          await new Promise((resolve) => setTimeout(resolve, ERROR_BACKOFF_MS));
        }
      }
    })();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.blockingClient && this.blockingClient !== this.redis) {
      this.blockingClient.disconnect?.();
    }
    this.blockingClient = null;
    await this.loopPromise?.catch(() => undefined);
    this.loopPromise = null;
  }
}
