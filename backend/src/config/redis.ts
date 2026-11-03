import Redis from 'ioredis';
import { env } from './env';

// Singleton de Redis compartido por limitador, idempotencia, retos y bus de eventos.
// Las lecturas bloqueantes de streams usan conexiones propias (createRedisConnection).
let client: Redis | null = null;

export function getRedis(): Redis {
  if (!client) {
    client = createRedisConnection('core');
  }
  return client;
}

export function createRedisConnection(name: string): Redis {
  const conn = new Redis(env.REDIS_URL, {
    connectionName: `xchanger-${name}`,
    maxRetriesPerRequest: 3,
    lazyConnect: false,
  });
  conn.on('error', (err) => console.error(`[redis:${name}]`, err.message));
  return conn;
}

export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit().catch(() => undefined);
    client = null;
  }
}
