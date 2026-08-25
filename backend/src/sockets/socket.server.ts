import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { Role } from '@prisma/client';

import { env } from '../config/env';
import { prisma } from '../config/prisma';
import { AccessTokenPayload } from '../middleware/authenticate';
import { registerOfferHandlers } from './handlers/offer.handler';
import { registerTicketHandlers } from './handlers/ticket.handler';

// La instancia de io se inyecta desde server.ts
let _io: Server;

export function getIo(): Server {
  if (!_io) throw new Error('Socket.io no ha sido inicializado');
  return _io;
}

// Extiende el tipo Socket para llevar el usuario autenticado
export interface AuthenticatedSocket extends Socket {
  user: AccessTokenPayload;
}

/**
 * Inicializa el servidor de Socket.io:
 *  1. Middleware de autenticación JWT (desde cookie access_token).
 *  2. Registro de handlers por dominio.
 */
export function initSocketServer(io: Server): void {
  _io = io;

  // ── Middleware de autenticación en el handshake ───────────
  io.use(async (socket, next) => {
    // El cliente envía la cookie access_token en el handshake
    const rawCookies: string = socket.handshake.headers.cookie ?? '';
    const token = parseCookieValue(rawCookies, 'access_token')
      ?? (socket.handshake.auth?.token as string | undefined);

    if (!token) {
      return next(new Error('Autenticación requerida'));
    }

    let payload: AccessTokenPayload;
    try {
      payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessTokenPayload;
    } catch {
      return next(new Error('Token inválido o expirado'));
    }

    // Verificar que el usuario sigue activo y no está bloqueado
    const user = await prisma.user.findFirst({
      where: { id: payload.sub, deletedAt: null },
      select: { role: true },
    });

    if (!user || user.role === Role.BLOQUEADO) {
      return next(new Error('Acceso denegado'));
    }

    (socket as AuthenticatedSocket).user = payload;
    next();
  });

  // ── Registro de handlers ──────────────────────────────────
  io.on('connection', (socket) => {
    const authSocket = socket as AuthenticatedSocket;
    const userId = authSocket.user.sub;

    // Sala personal del usuario: recibe notificaciones del sistema
    void socket.join(`user:${userId}`);

    console.log(`[socket] usuario ${userId} conectado (${socket.id})`);

    registerOfferHandlers(io, authSocket);
    registerTicketHandlers(io, authSocket);

    socket.on('disconnect', () => {
      console.log(`[socket] usuario ${userId} desconectado (${socket.id})`);
    });
  });
}

// ── Helpers ───────────────────────────────────────────────────

/** Extrae el valor de una cookie por nombre desde la cadena raw */
function parseCookieValue(cookieHeader: string, name: string): string | undefined {
  const entry = cookieHeader
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${name}=`));
  return entry ? decodeURIComponent(entry.slice(name.length + 1)) : undefined;
}

/**
 * Emite una notificación en tiempo real a la sala personal de un usuario.
 * Si el usuario no está conectado, se ignora silenciosamente
 * (la notificación persistente ya se guardó en BD).
 */
export function emitToUser(userId: string, event: string, payload: unknown): void {
  _io?.to(`user:${userId}`).emit(event, payload);
}
