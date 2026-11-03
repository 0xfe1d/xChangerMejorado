import os from 'os';
import Redis from 'ioredis';
import { createRedisConnection, getRedis } from '../config/redis';
import { EVENTS_STREAM, EventEnvelope } from './types';

export type EventHandler = (event: EventEnvelope) => Promise<void>;

const MAX_DELIVERIES = 5;
const CLAIM_IDLE_MS = 30_000;
const DEDUP_TTL_SECONDS = 24 * 60 * 60;

type StreamEntries = Array<[string, string[]]>;

/**
 * Consumidor de un grupo de Redis Streams. Cada grupo recibe todos los eventos
 * y las réplicas del mismo grupo se los reparten. Garantías:
 *  · deduplicación por event.id (entrega al menos una vez → efecto una vez)
 *  · un fallo deja el mensaje pendiente; se reclama con XAUTOCLAIM y se
 *    reintenta hasta MAX_DELIVERIES, después se descarta registrándolo.
 */
export class StreamConsumer {
  private readonly consumer = `${os.hostname()}-${process.pid}`;
  private blocking: Redis | null = null;
  private stopped = true;
  private loopPromise: Promise<void> | null = null;

  constructor(
    public readonly group: string,
    private readonly handler: EventHandler,
  ) {}

  async ensureGroup(): Promise<void> {
    try {
      // '$' = solo eventos nuevos al crear el grupo por primera vez
      await getRedis().xgroup('CREATE', EVENTS_STREAM, this.group, '$', 'MKSTREAM');
    } catch (err) {
      if (!String((err as Error).message).includes('BUSYGROUP')) throw err;
    }
  }

  /** Procesa una entrada; devuelve true si debe confirmarse (ACK). */
  private async handleEntry(streamId: string, fields: string[]): Promise<boolean> {
    const redis = getRedis();
    const raw = fields[fields.indexOf('event') + 1];
    let event: EventEnvelope;
    try {
      event = JSON.parse(raw) as EventEnvelope;
    } catch {
      console.error(`[consumer:${this.group}] evento ilegible ${streamId}, descartado`);
      return true;
    }

    const doneKey = `evt:done:${this.group}:${event.id}`;
    if (await redis.exists(doneKey)) return true;

    try {
      await this.handler(event);
      await redis.set(doneKey, '1', 'EX', DEDUP_TTL_SECONDS);
      await redis.del(`evt:tries:${this.group}:${event.id}`);
      return true;
    } catch (err) {
      const tries = await redis.incr(`evt:tries:${this.group}:${event.id}`);
      await redis.expire(`evt:tries:${this.group}:${event.id}`, DEDUP_TTL_SECONDS);
      console.error(`[consumer:${this.group}] fallo ${tries}/${MAX_DELIVERIES} en ${event.type} ${event.id}:`, (err as Error).message);
      return tries >= MAX_DELIVERIES; // tras el máximo se confirma para no bloquear (dead letter en log)
    }
  }

  private async processEntries(entries: StreamEntries): Promise<number> {
    const redis = getRedis();
    for (const [id, fields] of entries) {
      if (await this.handleEntry(id, fields)) {
        await redis.xack(EVENTS_STREAM, this.group, id);
      }
    }
    return entries.length;
  }

  /** Lee sin bloquear hasta vaciar lo disponible (usado por tests y al arrancar). */
  async processAvailable(): Promise<number> {
    await this.ensureGroup();
    const redis = getRedis();
    let total = 0;
    for (;;) {
      const res = (await redis.xreadgroup('GROUP', this.group, this.consumer, 'COUNT', 50, 'STREAMS', EVENTS_STREAM, '>')) as
        | Array<[string, StreamEntries]>
        | null;
      const entries = res?.[0]?.[1] ?? [];
      if (entries.length === 0) break;
      total += await this.processEntries(entries);
    }
    return total + (await this.reclaimStale(0));
  }

  /** Reintenta mensajes pendientes de consumidores caídos o de fallos previos. */
  async reclaimStale(minIdleMs = CLAIM_IDLE_MS): Promise<number> {
    const redis = getRedis();
    const res = (await redis.xautoclaim(EVENTS_STREAM, this.group, this.consumer, minIdleMs, '0-0', 'COUNT', 50)) as [string, StreamEntries];
    const entries = (res?.[1] ?? []).filter((e) => e && e[1]);
    return this.processEntries(entries);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.blocking = createRedisConnection(`consumer-${this.group}`);
    let lastClaim = Date.now();
    this.loopPromise = (async () => {
      await this.ensureGroup();
      while (!this.stopped) {
        try {
          const res = (await this.blocking!.xreadgroup('GROUP', this.group, this.consumer, 'COUNT', 50, 'BLOCK', 2000, 'STREAMS', EVENTS_STREAM, '>')) as
            | Array<[string, StreamEntries]>
            | null;
          const entries = res?.[0]?.[1] ?? [];
          if (entries.length) await this.processEntries(entries);
          if (Date.now() - lastClaim > CLAIM_IDLE_MS) {
            lastClaim = Date.now();
            await this.reclaimStale();
          }
        } catch (err) {
          if (this.stopped) break;
          console.error(`[consumer:${this.group}]`, (err as Error).message);
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    })();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.blocking) {
      this.blocking.disconnect();
      this.blocking = null;
    }
    await this.loopPromise?.catch(() => undefined);
  }
}
