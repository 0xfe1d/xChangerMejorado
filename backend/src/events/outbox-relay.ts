import crypto from 'crypto';
import { prisma } from '../config/prisma';
import { getRedis } from '../config/redis';
import { EVENTS_STREAM } from './types';
import { onEventEnqueued } from './event-publisher';

const LOCK_KEY = 'lock:outbox-relay';
const LOCK_TTL_MS = 10_000;
const BATCH = 100;
const MAX_ATTEMPTS = 20;
const STREAM_MAXLEN = 1_000_000;
const PURGE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

const RELEASE_LUA = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

/**
 * Vuelca el outbox a Redis Streams en orden. Un lock en Redis garantiza que
 * solo una réplica del core publica a la vez. Entrega "al menos una vez":
 * si el proceso cae entre XADD y marcar como publicado, el evento se repite
 * y los consumidores lo deduplican por id.
 * Devuelve el número de eventos publicados.
 */
export async function flushOutbox(): Promise<number> {
  const redis = getRedis();
  const token = crypto.randomUUID();
  const locked = await redis.set(LOCK_KEY, token, 'PX', LOCK_TTL_MS, 'NX');
  if (!locked) return 0;

  let published = 0;
  try {
    for (;;) {
      const rows = await prisma.outbox.findMany({
        where: { publishedAt: null, attempts: { lt: MAX_ATTEMPTS } },
        orderBy: { id: 'asc' },
        take: BATCH,
      });
      if (rows.length === 0) break;
      for (const row of rows) {
        try {
          await redis.xadd(EVENTS_STREAM, 'MAXLEN', '~', String(STREAM_MAXLEN), '*', 'event', JSON.stringify(row.payload));
          await prisma.outbox.update({ where: { id: row.id }, data: { publishedAt: new Date(), attempts: { increment: 1 } } });
          published++;
        } catch (err) {
          await prisma.outbox
            .update({ where: { id: row.id }, data: { attempts: { increment: 1 }, lastError: String((err as Error).message).slice(0, 500) } })
            .catch(() => undefined);
          // Se detiene el lote para no adelantar eventos posteriores (orden por stream)
          return published;
        }
      }
      if (rows.length < BATCH) break;
    }
  } finally {
    await redis.eval(RELEASE_LUA, 1, LOCK_KEY, token).catch(() => undefined);
  }
  return published;
}

export async function purgePublished(): Promise<number> {
  const { count } = await prisma.outbox.deleteMany({
    where: { publishedAt: { lt: new Date(Date.now() - PURGE_AFTER_MS) } },
  });
  return count;
}

let timer: NodeJS.Timeout | null = null;
let purgeTimer: NodeJS.Timeout | null = null;
let running = false;
let backoffMs = 0;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await flushOutbox();
    backoffMs = 0;
  } catch (err) {
    // Espera exponencial ante caída de Redis o de la BD
    backoffMs = Math.min(backoffMs ? backoffMs * 2 : 500, 30_000);
    console.error('[outbox] error publicando, reintento en', backoffMs, 'ms:', (err as Error).message);
  } finally {
    running = false;
  }
}

export function startOutboxRelay(intervalMs: number): void {
  if (timer || intervalMs <= 0) return;
  const loop = () => {
    timer = setTimeout(async () => {
      await tick();
      loop();
    }, intervalMs + backoffMs);
  };
  loop();
  onEventEnqueued(() => setImmediate(() => void tick()));
  purgeTimer = setInterval(() => purgePublished().catch(() => undefined), 60 * 60 * 1000);
}

export function stopOutboxRelay(): void {
  if (timer) clearTimeout(timer);
  if (purgeTimer) clearInterval(purgeTimer);
  timer = null;
  purgeTimer = null;
}
