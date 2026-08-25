import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { Role } from '@prisma/client';

import { env } from '../config/env';
import { prisma } from '../config/prisma';
import { AppError } from './errorHandler';
import { logAction } from '../services/log.service';

// ── Payload del Access Token ──────────────────────────────────
export interface AccessTokenPayload {
  sub: string;   // User.id
  email: string;
  role: Role;
  jti: string;   // ID único del token (para revocación futura)
}

// Extiende el tipado de Express para que req.user esté disponible
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AccessTokenPayload;
    }
  }
}

// ── Extrae el JWT de la cookie HttpOnly 'access_token' ────────
function extractToken(req: Request): string | null {
  const tokenFromCookie = req.cookies?.access_token as string | undefined;
  if (tokenFromCookie) return tokenFromCookie;

  // Fallback: Authorization: Bearer <token> (útil para tests/Postman)
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  return null;
}

// ── Middleware principal de autenticación ─────────────────────
// Implementa el modelo Zero-Trust del SDD:
//   1. Verifica firma y expiración del JWT
//   2. Verifica que el usuario no esté BLOQUEADO
//   3. Adjunta el payload a req.user
export async function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const token = extractToken(req);

  if (!token) {
    return next(new AppError(401, 'Autenticación requerida'));
  }

  let payload: AccessTokenPayload;

  try {
    payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessTokenPayload;
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      return next(new AppError(401, 'Sesión expirada'));
    }
    return next(new AppError(401, 'Token inválido'));
  }

  // Verificar que el usuario existe y no está bloqueado.
  // Se consulta solo los campos necesarios para minimizar latencia.
  const user = await prisma.user.findUnique({
    where: { id: payload.sub, deletedAt: null },
    select: { id: true, role: true, email: true },
  });

  if (!user) {
    return next(new AppError(401, 'Usuario no encontrado'));
  }


  if (user.role === Role.BLOQUEADO) {
    return next(new AppError(403, 'Tu cuenta está bloqueada'));
  }

  req.user = payload;
  next();
}

// ── Guard de roles ────────────────────────────────────────────
// Uso: router.get('/ruta', authenticate, requireRole(Role.EMBAJADOR, Role.PROPIETARIO), handler)
export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      return next(new AppError(401, 'Autenticación requerida'));
    }
    if (!roles.includes(req.user.role)) {
      return next(new AppError(403, 'No tienes permisos para esta acción'));
    }
    next();
  };
}
