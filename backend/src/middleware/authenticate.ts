import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { Role } from '@prisma/client';

import { env } from '../config/env';
import { prisma } from '../config/prisma';
import { AppError } from './errorHandler';
import { verifyServiceToken, ServiceClaims } from '../services/service-auth.service';
import { liftExpiredBlock, accountBlockedError } from '../services/account-state.service';

// ── Tokens ────────────────────────────────────────────────────

/** Payload del Access Token web (cookie). */
export interface AccessTokenPayload {
  sub: string;   // User.id
  email: string;
  role: Role;
  jti: string;
  /** Momento (s) del inicio de sesión que originó esta sesión; se conserva al refrescar. */
  auth_time?: number;
  /** Momento (s) de la última reautenticación (EP-C-27). */
  reauth_at?: number;
  /** Sesión iniciada con "Recordar inicio de sesión" (refresh de larga duración). */
  rem?: boolean;
}

/** Payload del Access Token de canal (EP-C-06). Firmado con JWT_CHANNEL_SECRET. */
export interface ChannelAccessTokenPayload {
  sub: string;
  typ: 'channel_access';
  ch: 'telegram';
  sid: string; // ChannelSession.id
}

export type ClientType = 'web' | 'channel';

/**
 * Principal autenticado (§5.2). Mantiene la forma de req.user anterior
 * (sub, email, role, jti) para que controladores y servicios no cambien.
 */
export interface Principal extends AccessTokenPayload {
  client: ClientType;
  channel?: 'telegram';
  channelSessionId?: string;
  serviceClientId?: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: Principal;
      service?: ServiceClaims;
      allowedClients?: ClientType[];
    }
  }
}

// ── Extractores ───────────────────────────────────────────────

interface CredentialExtractor {
  supports(req: Request): boolean;
  extract(req: Request): Promise<Principal>;
}

function bearer(value: string | undefined): string | null {
  return value?.startsWith('Bearer ') ? value.slice(7).trim() || null : null;
}

/**
 * Servicio + token de canal. Exige, en este orden: JWT de servicio con scope
 * channel:<canal>; Bearer de canal válido del mismo canal; sesión no revocada.
 * Un token de canal robado no sirve sin la credencial del servicio, y viceversa.
 */
const serviceChannelExtractor: CredentialExtractor = {
  supports: (req) => req.header('x-service-authorization') !== undefined,
  async extract(req) {
    const serviceToken = bearer(req.header('x-service-authorization'));
    if (!serviceToken) throw new AppError(401, 'Credencial de servicio requerida', 'SERVICE_UNAUTHORIZED');
    const service = await verifyServiceToken(serviceToken, 'channel:telegram');
    req.service = service;

    const userToken = bearer(req.header('authorization'));
    if (!userToken) throw new AppError(401, 'Token de canal requerido', 'UNAUTHORIZED');

    let payload: ChannelAccessTokenPayload;
    try {
      payload = jwt.verify(userToken, env.JWT_CHANNEL_SECRET, { algorithms: ['HS256'] }) as ChannelAccessTokenPayload;
    } catch (err) {
      if (err instanceof jwt.TokenExpiredError) throw new AppError(401, 'Sesión de canal expirada', 'TOKEN_EXPIRED');
      throw new AppError(401, 'Token de canal inválido', 'INVALID_TOKEN');
    }
    if (payload.typ !== 'channel_access' || payload.ch !== 'telegram') {
      throw new AppError(401, 'Token de canal inválido', 'INVALID_TOKEN');
    }

    const session = await prisma.channelSession.findUnique({
      where: { id: payload.sid },
      select: { revokedAt: true, absoluteExpiresAt: true, lastUsedAt: true, identity: { select: { userId: true, revokedAt: true } } },
    });
    const now = new Date();
    if (!session || session.revokedAt || session.identity.revokedAt || session.absoluteExpiresAt <= now || session.identity.userId !== payload.sub) {
      throw new AppError(401, 'Sesión de canal revocada', 'SESSION_REVOKED');
    }
    // Actualización de uso con baja frecuencia (EP-C-10 muestra lastUsedAt)
    if (now.getTime() - session.lastUsedAt.getTime() > 60_000) {
      prisma.channelSession.update({ where: { id: payload.sid }, data: { lastUsedAt: now } }).catch(() => undefined);
    }

    return {
      sub: payload.sub,
      email: '',
      role: Role.ESTUDIANTE, // se sustituye por el rol actual de la BD
      jti: payload.sid,
      client: 'channel',
      channel: 'telegram',
      channelSessionId: payload.sid,
      serviceClientId: service.sub,
    };
  },
};

/** Cookie access_token (o Bearer web para herramientas como Postman). */
const cookieExtractor: CredentialExtractor = {
  supports: () => true,
  async extract(req) {
    const token = (req.cookies?.access_token as string | undefined) ?? bearer(req.header('authorization'));
    if (!token) throw new AppError(401, 'Autenticación requerida', 'UNAUTHORIZED');
    try {
      const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'] }) as AccessTokenPayload & { purpose?: string };
      // Los JWT de propósito específico (otp_verify, mfa_challenge…) no son sesiones
      if (payload.purpose) throw new AppError(401, 'Token inválido', 'INVALID_TOKEN');
      return { ...payload, client: 'web' };
    } catch (err) {
      if (err instanceof AppError) throw err;
      if (err instanceof jwt.TokenExpiredError) throw new AppError(401, 'Sesión expirada', 'TOKEN_EXPIRED');
      throw new AppError(401, 'Token inválido', 'INVALID_TOKEN');
    }
  },
};

const EXTRACTORS: CredentialExtractor[] = [serviceChannelExtractor, cookieExtractor];

// ── Política de canal por ruta (§5.5, ADR-21) ─────────────────

/**
 * Declara qué tipos de cliente admite la ruta. Debe ir ANTES de authenticate.
 * Por defecto (sin declaración) una ruta solo admite web.
 */
export function allowClients(...clients: ClientType[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    req.allowedClients = clients;
    next();
  };
}

// ── Middleware principal ──────────────────────────────────────

export async function authenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    if (req.header('x-service-authorization') !== undefined && req.cookies?.access_token) {
      throw new AppError(400, 'La petición trae a la vez cookie de sesión y credencial de servicio', 'AMBIGUOUS_CREDENTIALS');
    }

    const extractor = EXTRACTORS.find((e) => e.supports(req))!;
    const principal = await extractor.extract(req);

    const allowed = req.allowedClients ?? ['web'];
    req.allowedClients = undefined;
    if (!allowed.includes(principal.client)) {
      throw new AppError(403, 'Esta ruta no está disponible para este canal', 'CHANNEL_FORBIDDEN_ROUTE');
    }

    // Consulta mínima por clave primaria en cada petición (Arquitectura v1.0 §6.3)
    const user = await prisma.user.findFirst({
      where: { id: principal.sub, deletedAt: null },
      select: { id: true, role: true, email: true, blockedUntil: true, blockReason: true },
    });
    if (!user) throw new AppError(401, 'Usuario no encontrado', 'UNAUTHORIZED');

    const role = await liftExpiredBlock(user);
    if (role === Role.BLOQUEADO) throw accountBlockedError(user);

    // El rol efectivo es el de la BD, no el del token: una degradación surte efecto ya
    req.user = { ...principal, role, email: user.email };
    next();
  } catch (err) {
    next(err);
  }
}

/** Exige solo credencial de servicio (endpoints de acceso S, sin usuario). */
export function requireService(scope: string) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      if (req.cookies?.access_token) {
        throw new AppError(400, 'La petición trae a la vez cookie de sesión y credencial de servicio', 'AMBIGUOUS_CREDENTIALS');
      }
      const token = bearer(req.header('x-service-authorization'));
      if (!token) throw new AppError(401, 'Credencial de servicio requerida', 'SERVICE_UNAUTHORIZED');
      req.service = await verifyServiceToken(token, scope);
      next();
    } catch (err) {
      next(err);
    }
  };
}

// ── Sesión reciente (acciones sensibles) ──────────────────────

export const REAUTH_VALIDITY_SECONDS = 10 * 60;
export const RECENT_LOGIN_SECONDS = 15 * 60;

/**
 * mode 'login-or-reauth': vale un login de menos de 15 min o una reautenticación
 * de menos de 10 min (aprobación de vinculaciones, EP-C-05).
 * mode 'reauth': exige reautenticación explícita reciente (activar MFA, EP-C-21).
 */
export function requireRecentAuth(mode: 'login-or-reauth' | 'reauth') {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const user = req.user;
    if (!user) return next(new AppError(401, 'Autenticación requerida', 'UNAUTHORIZED'));
    const now = Math.floor(Date.now() / 1000);
    const reauthOk = user.reauth_at !== undefined && now - user.reauth_at <= REAUTH_VALIDITY_SECONDS;
    const loginOk = mode === 'login-or-reauth' && user.auth_time !== undefined && now - user.auth_time <= RECENT_LOGIN_SECONDS;
    if (reauthOk || loginOk) return next();
    next(new AppError(401, 'Esta acción requiere reautenticación', 'REAUTH_REQUIRED'));
  };
}
