import { prisma } from '../config/prisma';
import { getRedis } from '../config/redis';
import { getMfaGateway } from './mfa/mfa.http-client';

type DepState = 'up' | 'down' | 'degraded';

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

export async function dependencies(): Promise<Record<'db' | 'redis' | 'mfa', DepState>> {
  const [db, redis, mfa] = await Promise.all([
    withTimeout(prisma.$queryRaw`SELECT 1`, 1500).then(() => 'up' as const, () => 'down' as const),
    withTimeout(getRedis().ping(), 1500).then(() => 'up' as const, () => 'down' as const),
    withTimeout(getMfaGateway().health(), 2500).catch(() => 'down' as const),
  ]);
  return { db, redis, mfa };
}

/** Las dependencias solo se revelan a la red interna (Docker / loopback). */
export function isInternalIp(ip: string | undefined): boolean {
  if (!ip) return false;
  const v = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  return (
    v === '127.0.0.1' || v === '::1' || v.startsWith('10.') || v.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(v)
  );
}
