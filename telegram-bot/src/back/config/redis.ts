import Redis from 'ioredis';
import { env } from './env';

let client: Redis | null = null;

/** Devuelve el cliente Redis compartido para almacenes, caché y deduplicación. */
export function getRedis(): Redis {
  if (!client) {
    client = createRedisConnection('bot');
  }
  return client;
}

/**
 * Crea una conexión dedicada de Redis (útil para lecturas bloqueantes
 * de `xchanger:events` con `XREADGROUP BLOCK`).
 */
export function createRedisConnection(name: string): Redis {
  const conn = new Redis(env.REDIS_URL, {
    connectionName: `xchanger-tg-${name}`,
    maxRetriesPerRequest: 3,
    lazyConnect: false,
  });
  conn.on('error', (err) => console.error(`[redis:${name}]`, err.message));
  return conn;
}

/** Cierra ordenadamente el cliente Redis compartido. */
export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit().catch(() => undefined);
    client = null;
  }
}
