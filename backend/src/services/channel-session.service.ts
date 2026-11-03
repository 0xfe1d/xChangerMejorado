import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { Channel, Prisma, Role } from '@prisma/client';

import { env } from '../config/env';
import { prisma } from '../config/prisma';
import { AppError } from '../middleware/errorHandler';
import { ChannelAccessTokenPayload } from '../middleware/authenticate';
import { publish, notifyEnqueued } from '../events/event-publisher';
import { randomToken, sha256Hex } from '../utils/crypto';
import { hasExpediente } from './expediente.service';
import { liftExpiredBlock, accountBlockedError } from './account-state.service';

type Tx = Prisma.TransactionClient;

export const CHANNEL_ACCESS_TTL_SECONDS = 15 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;

export type RevokeReason = 'USER' | 'ADMIN' | 'BLOCKED' | 'REUSE_DETECTED' | 'MFA_RESET' | 'ROTATED' | 'RELINKED';

/** Nombre externo del canal en la API ('telegram') ↔ enum de la BD. */
export const toDbChannel = (_c: 'telegram'): Channel => Channel.TELEGRAM;
export const fromDbChannel = (_c: Channel): 'telegram' => 'telegram';

function signChannelAccessToken(userId: string, sessionId: string): string {
  const payload: ChannelAccessTokenPayload = { sub: userId, typ: 'channel_access', ch: 'telegram', sid: sessionId };
  return jwt.sign(payload, env.JWT_CHANNEL_SECRET, { algorithm: 'HS256', expiresIn: CHANNEL_ACCESS_TTL_SECONDS, jwtid: crypto.randomUUID() });
}

/** Respuesta de sesión emitida (EP-C-06, §9.3). */
export interface IssuedChannelSession {
  accessToken: string;
  accessTokenExpiresIn: number;
  refreshToken: string;
  refreshTokenExpiresIn: number;
  session: { id: string; absoluteExpiresAt: string };
  user: { id: string; name: string; role: Role; mfaEnabled: boolean; hasExpediente: boolean };
}

interface CreateSessionOptions {
  familyId?: string;
  absoluteExpiresAt?: Date;
}

async function createSessionRow(tx: Tx, identityId: string, opts: CreateSessionOptions = {}) {
  const refreshToken = randomToken(32); // 43 caracteres base64url, 256 bits
  const now = Date.now();
  const absoluteExpiresAt = opts.absoluteExpiresAt ?? new Date(now + env.CHANNEL_REFRESH_ABSOLUTE_DAYS * DAY_MS);
  const idleExpiry = new Date(Math.min(now + env.CHANNEL_REFRESH_IDLE_DAYS * DAY_MS, absoluteExpiresAt.getTime()));
  const session = await tx.channelSession.create({
    data: {
      identityId,
      refreshTokenHash: sha256Hex(refreshToken),
      familyId: opts.familyId ?? crypto.randomUUID(),
      expiresAt: idleExpiry,
      absoluteExpiresAt,
    },
  });
  return { session, refreshToken };
}

async function buildIssued(userId: string, session: { id: string; expiresAt: Date; absoluteExpiresAt: Date }, refreshToken: string): Promise<IssuedChannelSession> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { id: true, name: true, role: true, mfaEnabled: true } });
  return {
    accessToken: signChannelAccessToken(userId, session.id),
    accessTokenExpiresIn: CHANNEL_ACCESS_TTL_SECONDS,
    refreshToken,
    refreshTokenExpiresIn: Math.max(0, Math.floor((session.expiresAt.getTime() - Date.now()) / 1000)),
    session: { id: session.id, absoluteExpiresAt: session.absoluteExpiresAt.toISOString() },
    user: { ...user, hasExpediente: await hasExpediente(userId) },
  };
}

/**
 * Garantiza una identidad activa (canal, externalUserId) para el usuario.
 *  · Si esa identidad externa ya pertenece a otra cuenta → 409 CHANNEL_IDENTITY_TAKEN.
 *  · Si el usuario tenía otra identidad activa en el canal, se revoca (una por canal).
 */
export async function ensureIdentity(
  tx: Tx,
  input: { userId: string; channel: Channel; externalUserId: string; displayName: string },
): Promise<{ identityId: string; created: boolean; replacedIdentityIds: string[] }> {
  const existing = await tx.channelIdentity.findFirst({
    where: { channel: input.channel, externalUserId: input.externalUserId, revokedAt: null },
  });
  if (existing && existing.userId !== input.userId) {
    throw new AppError(409, 'Esta cuenta de Telegram ya está vinculada a otro usuario', 'CHANNEL_IDENTITY_TAKEN');
  }
  if (existing) {
    if (existing.displayName !== input.displayName) {
      await tx.channelIdentity.update({ where: { id: existing.id }, data: { displayName: input.displayName } });
    }
    return { identityId: existing.id, created: false, replacedIdentityIds: [] };
  }

  const previous = await tx.channelIdentity.findMany({
    where: { userId: input.userId, channel: input.channel, revokedAt: null },
    select: { id: true },
  });
  const replacedIdentityIds = previous.map((p) => p.id);
  if (replacedIdentityIds.length) {
    await revokeIdentitiesTx(tx, replacedIdentityIds, 'RELINKED');
  }
  const identity = await tx.channelIdentity.create({
    data: { userId: input.userId, channel: input.channel, externalUserId: input.externalUserId, displayName: input.displayName },
  });
  return { identityId: identity.id, created: true, replacedIdentityIds };
}

/** Crea la sesión de canal para una identidad (BodySessionIssuer, §5.3). */
export async function issueSessionForIdentity(identityId: string, userId: string): Promise<IssuedChannelSession> {
  const { session, refreshToken } = await prisma.$transaction((tx) => createSessionRow(tx, identityId));
  return buildIssued(userId, session, refreshToken);
}

// ── Refresco con rotación (grant_type=refresh_token) ──────────

export async function refresh(input: { refreshToken: string; channel: Channel; externalUserId: string }): Promise<IssuedChannelSession> {
  const row = await prisma.channelSession.findUnique({
    where: { refreshTokenHash: sha256Hex(input.refreshToken) },
    include: { identity: true },
  });
  if (!row || row.identity.channel !== input.channel || row.identity.externalUserId !== input.externalUserId) {
    throw new AppError(400, 'Refresh token no válido', 'INVALID_GRANT');
  }

  if (row.revokedAt) {
    // Reutilización de un token ya rotado: posible robo → se revoca toda la familia
    if (row.revokedReason === 'ROTATED') {
      await revokeFamily(row.familyId, 'REUSE_DETECTED');
    }
    throw new AppError(400, 'Refresh token no válido', 'INVALID_GRANT');
  }
  const now = new Date();
  if (row.identity.revokedAt) throw new AppError(400, 'Refresh token no válido', 'INVALID_GRANT');
  if (row.expiresAt <= now || row.absoluteExpiresAt <= now) {
    throw new AppError(410, 'La sesión de canal ha caducado', 'EXPIRED_TOKEN');
  }

  const user = await prisma.user.findFirst({
    where: { id: row.identity.userId, deletedAt: null },
    select: { id: true, role: true, blockedUntil: true, blockReason: true },
  });
  if (!user) throw new AppError(400, 'Refresh token no válido', 'INVALID_GRANT');
  if ((await liftExpiredBlock(user)) === Role.BLOQUEADO) {
    await revokeAllChannelSessionsForUser(user.id, 'BLOCKED');
    throw accountBlockedError(user);
  }

  // Rotación: la fila vieja queda revocada como ROTATED; la nueva hereda familia y caducidad absoluta.
  // La condición sobre revokedAt evita que dos refrescos simultáneos con el mismo token prosperen.
  const created = await prisma.$transaction(async (tx) => {
    const { count } = await tx.channelSession.updateMany({
      where: { id: row.id, revokedAt: null },
      data: { revokedAt: now, revokedReason: 'ROTATED', lastUsedAt: now },
    });
    if (count === 0) return null;
    return createSessionRow(tx, row.identityId, { familyId: row.familyId, absoluteExpiresAt: row.absoluteExpiresAt });
  });
  if (!created) {
    await revokeFamily(row.familyId, 'REUSE_DETECTED');
    throw new AppError(400, 'Refresh token no válido', 'INVALID_GRANT');
  }
  return buildIssued(user.id, created.session, created.refreshToken);
}

// ── Revocación ────────────────────────────────────────────────

async function sessionRevokedEvents(
  tx: Tx,
  sessions: Array<{ id: string; identity: { userId: string; externalUserId: string; channel: Channel } }>,
  reason: RevokeReason,
) {
  for (const s of sessions) {
    await publish(
      'channel.session.revoked',
      { channel: fromDbChannel(s.identity.channel), externalUserId: s.identity.externalUserId, sessionId: s.id, reason },
      { audience: [s.identity.userId], tx },
    );
  }
}

async function revokeSessionsWhere(tx: Tx, where: Prisma.ChannelSessionWhereInput, reason: RevokeReason) {
  const sessions = await tx.channelSession.findMany({
    where: { ...where, revokedAt: null },
    select: { id: true, identity: { select: { userId: true, externalUserId: true, channel: true } } },
  });
  if (sessions.length === 0) return 0;
  await tx.channelSession.updateMany({
    where: { id: { in: sessions.map((s) => s.id) } },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
  // Las rotaciones normales no generan evento; el resto avisa al bot para borrar su sesión local
  if (reason !== 'ROTATED') await sessionRevokedEvents(tx, sessions, reason);
  return sessions.length;
}

async function revokeIdentitiesTx(tx: Tx, identityIds: string[], reason: RevokeReason) {
  await revokeSessionsWhere(tx, { identityId: { in: identityIds } }, reason);
  await tx.channelIdentity.updateMany({ where: { id: { in: identityIds }, revokedAt: null }, data: { revokedAt: new Date() } });
}

export async function revokeFamily(familyId: string, reason: RevokeReason): Promise<void> {
  await prisma.$transaction((tx) => revokeSessionsWhere(tx, { familyId }, reason));
  notifyEnqueued();
}

export async function revokeSession(sessionId: string, reason: RevokeReason): Promise<void> {
  await prisma.$transaction((tx) => revokeSessionsWhere(tx, { id: sessionId }, reason));
  notifyEnqueued();
}

/** Bloqueo, reset de MFA…: revoca todas las sesiones de canal del usuario (las identidades se conservan). */
export async function revokeAllChannelSessionsForUser(userId: string, reason: RevokeReason): Promise<number> {
  const n = await prisma.$transaction((tx) => revokeSessionsWhere(tx, { identity: { userId } }, reason));
  notifyEnqueued();
  return n;
}

/** Desvincula: revoca identidad y sesiones (EP-C-09 scope=identity, EP-C-11). */
export async function revokeIdentity(identityId: string, reason: RevokeReason): Promise<void> {
  await prisma.$transaction((tx) => revokeIdentitiesTx(tx, [identityId], reason));
  notifyEnqueued();
}

export async function identityOfSession(sessionId: string) {
  return prisma.channelSession.findUnique({ where: { id: sessionId }, select: { identityId: true, identity: true } });
}

/** EP-C-10: identidades activas del usuario con su último uso. */
export async function listIdentitiesForUser(userId: string) {
  const identities = await prisma.channelIdentity.findMany({
    where: { userId, revokedAt: null },
    include: { sessions: { orderBy: { lastUsedAt: 'desc' }, take: 1, select: { lastUsedAt: true } } },
    orderBy: { linkedAt: 'desc' },
  });
  return identities.map((i) => ({
    identityId: i.id,
    channel: fromDbChannel(i.channel),
    displayName: i.displayName,
    linkedAt: i.linkedAt,
    lastUsedAt: i.sessions[0]?.lastUsedAt ?? null,
  }));
}
