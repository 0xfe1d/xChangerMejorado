import { getRedis } from '../../config/redis';

// Estado del reto de login web (mfa_challenge) en Redis: compartido entre réplicas.
export const MFA_CHALLENGE_TTL_SECONDS = 300;
export const MFA_CHALLENGE_MAX_ATTEMPTS = 5;

const key = (jti: string) => `mfa:chal:${jti}`;

export async function createChallenge(jti: string, userId: string): Promise<void> {
  await getRedis().set(key(jti), JSON.stringify({ userId, attempts: 0 }), 'EX', MFA_CHALLENGE_TTL_SECONDS);
}

export async function getChallenge(jti: string): Promise<{ userId: string; attempts: number } | null> {
  const raw = await getRedis().get(key(jti));
  return raw ? (JSON.parse(raw) as { userId: string; attempts: number }) : null;
}

/** Registra un fallo; al llegar al máximo el reto se invalida. Devuelve los intentos restantes. */
export async function registerFailure(jti: string): Promise<number> {
  const redis = getRedis();
  const current = await getChallenge(jti);
  if (!current) return 0;
  const attempts = current.attempts + 1;
  const remaining = MFA_CHALLENGE_MAX_ATTEMPTS - attempts;
  if (remaining <= 0) {
    await redis.del(key(jti));
    return 0;
  }
  const ttl = await redis.ttl(key(jti));
  await redis.set(key(jti), JSON.stringify({ ...current, attempts }), 'EX', ttl > 0 ? ttl : 1);
  return remaining;
}

/** Consume el reto: true solo para la primera petición que lo consiga (jti de un solo uso). */
export async function consumeChallenge(jti: string): Promise<boolean> {
  return (await getRedis().del(key(jti))) === 1;
}
