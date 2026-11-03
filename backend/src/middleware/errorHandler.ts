import { Request, Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';

/**
 * Error de dominio. `code` es el identificador estable que interpretan las
 * máquinas (bot, frontend); `message` sigue siendo el texto en español que
 * el frontend ya muestra a través de ApiError (§5.10).
 */
export class AppError extends Error {
  public readonly code: string;

  constructor(
    public readonly statusCode: number,
    message: string,
    code?: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code ?? defaultCode(statusCode);
  }
}

/** Código por defecto para errores existentes que aún no declaran uno propio. */
export function defaultCode(status: number): string {
  switch (status) {
    case 400: return 'VALIDATION_ERROR';
    case 401: return 'UNAUTHORIZED';
    case 403: return 'FORBIDDEN';
    case 404: return 'NOT_FOUND';
    case 409: return 'CONFLICT';
    case 410: return 'GONE';
    case 422: return 'UNPROCESSABLE';
    case 423: return 'LOCKED';
    case 429: return 'RATE_LIMITED';
    case 503: return 'SERVICE_UNAVAILABLE';
    default: return status >= 500 ? 'INTERNAL_ERROR' : 'ERROR';
  }
}

export interface ErrorBody {
  error: string;
  code: string;
  requestId?: string;
  details?: Record<string, unknown>;
  /** Compatibilidad con el frontend actual: el login bloqueado leía `detail`. */
  detail?: Record<string, unknown>;
}

export function buildErrorBody(err: AppError, requestId?: string): ErrorBody {
  const body: ErrorBody = { error: err.message, code: err.code, requestId };
  if (err.details) body.details = err.details;
  if (err.code === 'ACCOUNT_BLOCKED' && err.details) body.detail = { blocked: true, ...err.details };
  return body;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const requestId = req.requestId;

  if (err instanceof AppError) {
    const retryAfter = err.details?.retryAfter;
    if (typeof retryAfter === 'number') res.setHeader('Retry-After', String(retryAfter));
    res.status(err.statusCode).json(buildErrorBody(err, requestId));
    return;
  }

  // JSON mal formado o cuerpo demasiado grande (express.json)
  const status = (err as { status?: number; type?: string })?.status;
  if (status === 400 || status === 413) {
    const e = new AppError(status, status === 413 ? 'Cuerpo de petición demasiado grande' : 'JSON mal formado',
      status === 413 ? 'PAYLOAD_TOO_LARGE' : 'VALIDATION_ERROR');
    res.status(status).json(buildErrorBody(e, requestId));
    return;
  }

  // Violaciones de unicidad que se escapen de la comprobación previa del servicio
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    res.status(409).json(buildErrorBody(new AppError(409, 'El recurso ya existe', 'CONFLICT'), requestId));
    return;
  }

  // Errores inesperados: no filtrar detalles internos
  console.error('[errorHandler]', requestId, err);
  res.status(500).json(buildErrorBody(new AppError(500, 'Internal server error', 'INTERNAL_ERROR'), requestId));
}
