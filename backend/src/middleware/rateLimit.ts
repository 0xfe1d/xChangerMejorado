import { Request, Response, NextFunction } from 'express';
import { getRedis } from '../config/redis';
import { AppError } from './errorHandler';

export interface RateLimitRule {
  /** Prefijo lógico (p. ej. "login:ip"). */
  name: string;
  limit: number;
  windowSec: number;
  /** Devuelve la clave a limitar o undefined si la regla no aplica a esta petición. */
  key: (req: Request) => string | undefined;
}

/**
 * Ventana fija en Redis (INCR + EXPIRE). Compartida entre réplicas del core.
 * Si Redis no responde se deja pasar la petición (se prioriza la disponibilidad
 * del login) y se registra el fallo.
 */
export async function hitRateLimit(name: string, key: string, limit: number, windowSec: number): Promise<number | null> {
  const redisKey = `rl:${name}:${key}`;
  const redis = getRedis();
  const count = await redis.incr(redisKey);
  if (count === 1) await redis.expire(redisKey, windowSec);
  if (count > limit) {
    const ttl = await redis.ttl(redisKey);
    return ttl > 0 ? ttl : windowSec;
  }
  return null;
}

export function rateLimit(...rules: RateLimitRule[]) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      for (const rule of rules) {
        const key = rule.key(req);
        if (!key) continue;
        const retryAfter = await hitRateLimit(rule.name, key.toLowerCase(), rule.limit, rule.windowSec);
        if (retryAfter !== null) {
          return next(new AppError(429, 'Demasiados intentos. Inténtalo más tarde.', 'RATE_LIMITED', { retryAfter }));
        }
      }
      next();
    } catch (err) {
      console.error('[rateLimit] Redis no disponible, se omite el límite:', (err as Error).message);
      next();
    }
  };
}

// Claves habituales
export const byIp = (req: Request) => req.ip ?? 'unknown';
export const byBody = (field: string) => (req: Request) => {
  const v = (req.body as Record<string, unknown> | undefined)?.[field];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
};
