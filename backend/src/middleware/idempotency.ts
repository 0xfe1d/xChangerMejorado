import { Request, Response, NextFunction } from 'express';
import { getRedis } from '../config/redis';
import { AppError } from './errorHandler';
import { canonicalHash } from '../utils/crypto';

const TTL_SECONDS = 24 * 60 * 60;
// UUID (cualquier versión) o tg:<update_id> (§9.1)
const KEY_FORMAT = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|tg:\d{1,20})$/i;

interface StoredResponse {
  state: 'pending' | 'done';
  hash: string;
  status?: number;
  body?: unknown;
}

export interface IdempotencyOptions {
  /** Si es true y no llega cabecera, 400. Por defecto obligatoria solo para clientes de canal/servicio. */
  required?: (req: Request) => boolean;
}

const defaultRequired = (req: Request) => req.user?.client === 'channel' || (!req.user && !!req.service);

/**
 * Idempotency-Key (EP-C-29). Se guarda (servicio, usuario, clave) → (hash del
 * cuerpo, estado, respuesta) durante 24 h:
 *  · misma clave y mismo cuerpo → misma respuesta (cabecera Idempotent-Replayed)
 *  · misma clave y otro cuerpo  → 422 IDEMPOTENCY_CONFLICT
 *  · petición original aún en curso → 409 IDEMPOTENCY_IN_PROGRESS
 * Debe ir DESPUÉS de authenticate / requireService.
 */
export function idempotency(options: IdempotencyOptions = {}) {
  const required = options.required ?? defaultRequired;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const key = req.header('idempotency-key');
    if (!key) {
      if (required(req)) return next(new AppError(400, 'Falta la cabecera Idempotency-Key', 'IDEMPOTENCY_KEY_REQUIRED'));
      return next();
    }
    if (!KEY_FORMAT.test(key)) return next(new AppError(400, 'Idempotency-Key con formato inválido', 'VALIDATION_ERROR'));

    const actor = req.service?.sub ?? 'web';
    const subject = req.user?.sub ?? 'anon';
    const redisKey = `idem:${actor}:${subject}:${key}`;
    const hash = canonicalHash({ m: req.method, p: req.baseUrl + req.path, b: req.body ?? null });
    const redis = getRedis();

    try {
      const pending: StoredResponse = { state: 'pending', hash };
      const acquired = await redis.set(redisKey, JSON.stringify(pending), 'EX', TTL_SECONDS, 'NX');
      if (!acquired) {
        const raw = await redis.get(redisKey);
        const stored = raw ? (JSON.parse(raw) as StoredResponse) : null;
        if (!stored) return next(new AppError(409, 'Petición idempotente en curso', 'IDEMPOTENCY_IN_PROGRESS'));
        if (stored.hash !== hash) {
          return next(new AppError(422, 'La Idempotency-Key ya se usó con otro cuerpo', 'IDEMPOTENCY_CONFLICT'));
        }
        if (stored.state === 'pending') {
          return next(new AppError(409, 'Petición idempotente en curso', 'IDEMPOTENCY_IN_PROGRESS'));
        }
        res.setHeader('Idempotent-Replayed', 'true');
        if (stored.body === undefined) {
          res.status(stored.status ?? 204).end();
        } else {
          res.status(stored.status ?? 200).json(stored.body);
        }
        return;
      }
    } catch (err) {
      console.error('[idempotency] Redis no disponible:', (err as Error).message);
      return next(new AppError(503, 'Servicio temporalmente no disponible', 'SERVICE_UNAVAILABLE'));
    }

    // Captura la respuesta para poder repetirla
    let captured: unknown;
    const originalJson = res.json.bind(res);
    res.json = (body: unknown) => {
      captured = body;
      return originalJson(body);
    };

    res.on('finish', () => {
      // Los errores del servidor no se memorizan: el cliente puede reintentar
      if (res.statusCode >= 500) {
        redis.del(redisKey).catch(() => undefined);
        return;
      }
      const done: StoredResponse = { state: 'done', hash, status: res.statusCode, body: captured };
      redis.set(redisKey, JSON.stringify(done), 'EX', TTL_SECONDS).catch(() => undefined);
    });

    next();
  };
}
