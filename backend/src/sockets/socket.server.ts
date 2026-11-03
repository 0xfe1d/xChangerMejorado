import { Server, Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import jwt from 'jsonwebtoken';
import { Role } from '@prisma/client';

import { env } from '../config/env';
import { prisma } from '../config/prisma';
import { createRedisConnection } from '../config/redis';
import { AccessTokenPayload } from '../middleware/authenticate';
import { liftExpiredBlock } from '../services/account-state.service';
import { registerOfferHandlers } from './handlers/offer.handler';
import { registerTicketHandlers } from './handlers/ticket.handler';

// La instancia de io se inyecta desde server.ts. Los servicios NO la usan
// (AR-04): solo la pasarela de eventos (events/consumers.ts) emite.
let _io: Server | null = null;

export function getIo(): Server {
  if (!_io) throw new Error('Socket.io no ha sido inicializado');
  return _io;
}

export function getIoOrNull(): Server | null {
  return _io;
}

export interface AuthenticatedSocket extends Socket {
  user: AccessTokenPayload;
}

/**
 * Inicializa Socket.io:
 *  1. Adaptador Redis para que varias réplicas del core compartan salas (AR-08).
 *  2. Autenticación en el handshake con la cookie access_token (RE-WS).
 *  3. Handlers por dominio.
 */
export function initSocketServer(io: Server, opts: { redisAdapter?: boolean } = {}): void {
  _io = io;

  if (opts.redisAdapter !== false) {
    const pub = createRedisConnection('socket-pub');
    const sub = pub.duplicate();
    io.adapter(createAdapter(pub, sub));
  }

  io.use(async (socket, next) => {
    const rawCookies: string = socket.handshake.headers.cookie ?? '';
    const token = parseCookieValue(rawCookies, 'access_token') ?? (socket.handshake.auth?.token as string | undefined);
    if (!token) return next(new Error('Autenticación requerida'));

    let payload: AccessTokenPayload & { purpose?: string };
    try {
      payload = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'] }) as AccessTokenPayload & { purpose?: string };
      if (payload.purpose) throw new Error('purpose');
    } catch {
      return next(new Error('Token inválido o expirado'));
    }

    const user = await prisma.user.findFirst({
      where: { id: payload.sub, deletedAt: null },
      select: { id: true, role: true, blockedUntil: true, blockReason: true },
    });
    if (!user || (await liftExpiredBlock(user)) === Role.BLOQUEADO) return next(new Error('Acceso denegado'));

    (socket as AuthenticatedSocket).user = { ...payload, role: user.role };
    next();
  });

  io.on('connection', (socket) => {
    const authSocket = socket as AuthenticatedSocket;
    void socket.join(`user:${authSocket.user.sub}`);
    registerOfferHandlers(io, authSocket);
    registerTicketHandlers(io, authSocket);
  });
}

function parseCookieValue(cookieHeader: string, name: string): string | undefined {
  const entry = cookieHeader
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${name}=`));
  return entry ? decodeURIComponent(entry.slice(name.length + 1)) : undefined;
}
