import { Channel, ChannelChallengeKind, LinkRequestStatus, RegistrationOrigin, Role } from '@prisma/client';
import jwt from 'jsonwebtoken';

import { env } from '../config/env';
import { prisma } from '../config/prisma';
import { AppError } from '../middleware/errorHandler';
import { randomToken, sha256Hex } from '../utils/crypto';
import { generateUserCode, formatUserCode, normalizeUserCode } from '../utils/user-code';
import { generateOtpCode, hashOtpCode, verifyOtpCode, signPurposeToken, verifyPurposeToken, PurposeTokenPayload, TokenPurpose } from '../utils/otp';
import { verifyPassword } from '../utils/password';
import { sendOtpEmail } from './email.service';
import { logAction } from './log.service';
import { createNotification } from './notification.service';
import { publish, notifyEnqueued } from '../events/event-publisher';
import { liftExpiredBlock, accountBlockedError } from './account-state.service';
import { registerPending, consumePendingRegistration } from './auth.service';
import { verifySecondFactor } from './mfa/second-factor';
import {
  ensureIdentity,
  issueSessionForIdentity,
  refresh as refreshChannelSession,
  revokeSession,
  revokeIdentity,
  identityOfSession,
  toDbChannel,
  IssuedChannelSession,
} from './channel-session.service';

export const LINK_TTL_SECONDS = 600;
export const LINK_POLL_INTERVAL_SECONDS = 5;
const EMAIL_OTP_TTL_SECONDS = 600;
const CHANNEL_MFA_TTL_SECONDS = 300;
const MAX_CHALLENGE_ATTEMPTS = 5;

export type ApiChannel = 'telegram';

export interface MfaRequiredResponse {
  mfaRequired: true;
  challengeToken: string;
  expiresIn: number;
  methods: Array<'xotp' | 'recovery_code'>;
}

export type TokenGrantResult = IssuedChannelSession | MfaRequiredResponse;

const invalidGrant = (msg = 'Concesión no válida') => new AppError(400, msg, 'INVALID_GRANT');

function decodeChallenge(token: string, purpose: TokenPurpose): PurposeTokenPayload {
  try {
    return verifyPurposeToken(token, purpose);
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) throw new AppError(410, 'El código ha caducado', 'EXPIRED_TOKEN');
    throw invalidGrant();
  }
}

async function loadActiveUser(userId: string) {
  const user = await prisma.user.findFirst({ where: { id: userId, deletedAt: null } });
  if (!user) throw invalidGrant();
  if ((await liftExpiredBlock(user)) === Role.BLOQUEADO) throw accountBlockedError(user);
  return user;
}

/** Crea o reutiliza la identidad y emite la sesión. Registra CHANNEL_LOGIN / CHANNEL_LINKED. */
async function openChannelSession(
  userId: string,
  channel: Channel,
  externalUserId: string,
  displayName: string,
  via: string,
): Promise<IssuedChannelSession> {
  const { identityId, created } = await prisma.$transaction((tx) => ensureIdentity(tx, { userId, channel, externalUserId, displayName }));
  notifyEnqueued();
  const issued = await issueSessionForIdentity(identityId, userId);
  logAction({
    userId,
    action: created ? 'CHANNEL_LINKED' : 'CHANNEL_LOGIN',
    payload: { client: 'channel', channel: 'telegram', via, identityId },
  }).catch(console.error);
  if (created) {
    // AR-16: aviso por correo de cada vinculación
    await createNotification({
      userId,
      asunto: 'Has vinculado Telegram a tu cuenta',
      contenido: `Se ha vinculado la cuenta de Telegram "${displayName}" a tu cuenta de xChanger.\nSi no has sido tú, desvincúlala desde Ajustes y cambia tu contraseña.`,
      kind: 'SECURITY',
    });
  }
  return issued;
}

// ── EP-C-03: solicitud de vinculación ─────────────────────────

export async function createLinkRequest(input: { channel: ApiChannel; externalUserId: string; displayName: string; username?: string }) {
  const deviceCode = randomToken(32);
  // Reintento ante la (improbable) colisión con un userCode PENDING activo
  for (let attempt = 0; attempt < 5; attempt++) {
    const userCode = generateUserCode();
    try {
      await prisma.channelLinkRequest.create({
        data: {
          deviceCodeHash: sha256Hex(deviceCode),
          userCode,
          channel: toDbChannel(input.channel),
          externalUserId: input.externalUserId,
          displayName: input.displayName,
          username: input.username ?? null,
          expiresAt: new Date(Date.now() + LINK_TTL_SECONDS * 1000),
        },
      });
      const formatted = formatUserCode(userCode);
      const base = env.CHANNEL_LINK_BASE_URL;
      return {
        deviceCode,
        userCode: formatted,
        verificationUri: base,
        verificationUriComplete: `${base}${base.includes('?') ? '&' : '?'}code=${encodeURIComponent(formatted)}`,
        expiresIn: LINK_TTL_SECONDS,
        interval: LINK_POLL_INTERVAL_SECONDS,
      };
    } catch (err) {
      if ((err as { code?: string }).code !== 'P2002') throw err;
    }
  }
  throw new AppError(503, 'No se pudo generar el código, inténtalo de nuevo', 'SERVICE_UNAVAILABLE');
}

// ── EP-C-04 / EP-C-05: aprobación desde la web ────────────────

async function findLinkByUserCode(rawCode: string) {
  const code = normalizeUserCode(rawCode);
  if (!code) throw new AppError(404, 'Solicitud de vinculación no encontrada', 'LINK_NOT_FOUND');
  const req = await prisma.channelLinkRequest.findFirst({ where: { userCode: code }, orderBy: { createdAt: 'desc' } });
  if (!req) throw new AppError(404, 'Solicitud de vinculación no encontrada', 'LINK_NOT_FOUND');
  if (req.status === LinkRequestStatus.PENDING && req.expiresAt <= new Date()) {
    await prisma.channelLinkRequest.update({ where: { id: req.id }, data: { status: LinkRequestStatus.EXPIRED } });
    req.status = LinkRequestStatus.EXPIRED;
  }
  if (req.status === LinkRequestStatus.EXPIRED) throw new AppError(410, 'La solicitud ha caducado', 'LINK_EXPIRED');
  return req;
}

export async function getLinkRequest(rawCode: string) {
  const req = await findLinkByUserCode(rawCode);
  if (req.status !== LinkRequestStatus.PENDING) throw new AppError(409, 'La solicitud ya fue decidida', 'LINK_ALREADY_DECIDED');
  // Datos para que el usuario reconozca la petición (§6.4)
  return {
    channel: 'telegram' as const,
    displayName: req.displayName,
    username: req.username,
    requestedAt: req.createdAt,
    expiresAt: req.expiresAt,
    status: req.status,
  };
}

export async function decideLinkRequest(rawCode: string, decision: 'approve' | 'deny', userId: string) {
  const req = await findLinkByUserCode(rawCode);
  if (req.status !== LinkRequestStatus.PENDING) throw new AppError(409, 'La solicitud ya fue decidida', 'LINK_ALREADY_DECIDED');

  if (decision === 'deny') {
    const { count } = await prisma.channelLinkRequest.updateMany({
      where: { id: req.id, status: LinkRequestStatus.PENDING },
      data: { status: LinkRequestStatus.DENIED },
    });
    if (count === 0) throw new AppError(409, 'La solicitud ya fue decidida', 'LINK_ALREADY_DECIDED');
    await publish('channel.link.denied', { channel: 'telegram', externalUserId: req.externalUserId, linkRequestId: req.id });
    return { status: 'DENIED' as const };
  }

  const user = await loadActiveUser(userId);
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.channelLinkRequest.updateMany({
      where: { id: req.id, status: LinkRequestStatus.PENDING },
      data: { status: LinkRequestStatus.APPROVED, approvedByUserId: user.id },
    });
    if (count === 0) throw new AppError(409, 'La solicitud ya fue decidida', 'LINK_ALREADY_DECIDED');
    // Una identidad activa por canal: la anterior del usuario se revoca dentro de ensureIdentity
    await ensureIdentity(tx, { userId: user.id, channel: req.channel, externalUserId: req.externalUserId, displayName: req.displayName });
    await publish(
      'channel.link.approved',
      { channel: 'telegram', externalUserId: req.externalUserId, linkRequestId: req.id },
      { audience: [user.id], tx },
    );
  });
  notifyEnqueued();

  logAction({ userId: user.id, action: 'CHANNEL_LINKED', payload: { channel: 'telegram', via: 'link_code', linkRequestId: req.id } }).catch(console.error);
  await createNotification({
    userId: user.id,
    asunto: 'Has vinculado Telegram a tu cuenta',
    contenido: `Has aprobado la vinculación de la cuenta de Telegram "${req.displayName}".\nSi no has sido tú, desvincúlala desde Ajustes y cambia tu contraseña.`,
    kind: 'SECURITY',
  });
  return { status: 'APPROVED' as const };
}

// ── EP-C-07: OTP de inicio de sesión por correo ───────────────

export async function sendLoginEmailOtp(input: { channel: ApiChannel; externalUserId: string; email: string }) {
  const email = input.email.toLowerCase();
  const user = await prisma.user.findFirst({ where: { email, deletedAt: null }, select: { id: true } });
  const otp = generateOtpCode();
  const { token, jti } = signPurposeToken('channel_email_otp', input.externalUserId, EMAIL_OTP_TTL_SECONDS);

  // Anti-enumeración: el reto se crea igual con userId nulo y la respuesta no cambia
  await prisma.channelLoginChallenge.create({
    data: {
      jti,
      kind: ChannelChallengeKind.EMAIL_OTP,
      channel: toDbChannel(input.channel),
      externalUserId: input.externalUserId,
      userId: user?.id ?? null,
      otpHash: await hashOtpCode(otp),
      expiresAt: new Date(Date.now() + EMAIL_OTP_TTL_SECONDS * 1000),
    },
  });
  if (user) {
    await sendOtpEmail(email, otp).catch((err) => console.error('[channel-auth] error enviando OTP:', err));
  }
  return { challengeToken: token, expiresIn: EMAIL_OTP_TTL_SECONDS, codeLength: 6 };
}

// ── EP-C-08: alta desde el canal ──────────────────────────────

export async function registerFromChannel(input: {
  channel: ApiChannel;
  externalUserId: string;
  name: string;
  email: string;
  carreraId: string;
  cursoId: string;
}) {
  const taken = await prisma.channelIdentity.count({
    where: { channel: toDbChannel(input.channel), externalUserId: input.externalUserId, revokedAt: null },
  });
  if (taken > 0) throw new AppError(409, 'Esta cuenta de Telegram ya está vinculada', 'CHANNEL_IDENTITY_TAKEN');

  const { token } = await registerPending({
    email: input.email,
    name: input.name,
    carreraId: input.carreraId,
    cursoId: input.cursoId,
    origin: RegistrationOrigin.TELEGRAM,
    externalUserId: input.externalUserId,
  });
  return { challengeToken: token, expiresIn: 1800, codeLength: 6 };
}

// ── EP-C-06: endpoint único de emisión ────────────────────────

export type TokenGrantInput =
  | { grant_type: 'link_code'; channel: ApiChannel; externalUserId: string; deviceCode: string }
  | { grant_type: 'email_otp'; channel: ApiChannel; externalUserId: string; challengeToken: string; code: string }
  | { grant_type: 'registration_otp'; channel: ApiChannel; externalUserId: string; challengeToken: string; code: string }
  | { grant_type: 'mfa'; channel: ApiChannel; externalUserId: string; challengeToken: string; code?: string; recoveryCode?: string }
  | { grant_type: 'refresh_token'; channel: ApiChannel; externalUserId: string; refreshToken: string };

export async function token(input: TokenGrantInput, ctx: { clientIp?: string } = {}): Promise<TokenGrantResult> {
  switch (input.grant_type) {
    case 'link_code':
      return grantLinkCode(input);
    case 'email_otp':
      return grantEmailOtp(input);
    case 'registration_otp':
      return grantRegistrationOtp(input);
    case 'mfa':
      return grantMfa(input, ctx);
    case 'refresh_token':
      return refreshChannelSession({ refreshToken: input.refreshToken, channel: toDbChannel(input.channel), externalUserId: input.externalUserId });
  }
}

async function grantLinkCode(input: Extract<TokenGrantInput, { grant_type: 'link_code' }>): Promise<IssuedChannelSession> {
  const req = await prisma.channelLinkRequest.findUnique({ where: { deviceCodeHash: sha256Hex(input.deviceCode) } });
  if (!req || req.externalUserId !== input.externalUserId || req.channel !== toDbChannel(input.channel)) throw invalidGrant();

  const now = new Date();
  if (req.status === LinkRequestStatus.EXPIRED || (req.status === LinkRequestStatus.PENDING && req.expiresAt <= now)) {
    throw new AppError(410, 'La solicitud de vinculación ha caducado', 'EXPIRED_TOKEN');
  }
  if (req.status === LinkRequestStatus.DENIED) throw new AppError(403, 'La vinculación fue rechazada', 'ACCESS_DENIED');
  if (req.status === LinkRequestStatus.CONSUMED) throw invalidGrant();

  if (req.status === LinkRequestStatus.PENDING) {
    // Sondeo más rápido que el intervalo acordado → SLOW_DOWN (estilo RFC 8628)
    const tooFast = req.lastPolledAt && now.getTime() - req.lastPolledAt.getTime() < (LINK_POLL_INTERVAL_SECONDS - 1) * 1000;
    await prisma.channelLinkRequest.update({ where: { id: req.id }, data: { lastPolledAt: now } });
    if (tooFast) throw new AppError(400, 'Sondeo demasiado frecuente', 'SLOW_DOWN', { interval: LINK_POLL_INTERVAL_SECONDS + 5 });
    throw new AppError(400, 'Esperando la aprobación del usuario', 'AUTHORIZATION_PENDING', { interval: LINK_POLL_INTERVAL_SECONDS });
  }

  // APPROVED → CONSUMED de forma atómica: un deviceCode solo emite una sesión
  const { count } = await prisma.channelLinkRequest.updateMany({
    where: { id: req.id, status: LinkRequestStatus.APPROVED },
    data: { status: LinkRequestStatus.CONSUMED },
  });
  if (count === 0) throw invalidGrant();

  const user = await loadActiveUser(req.approvedByUserId!);
  const identity = await prisma.channelIdentity.findFirst({
    where: { userId: user.id, channel: req.channel, externalUserId: req.externalUserId, revokedAt: null },
  });
  if (!identity) throw invalidGrant('La vinculación ya no está activa');
  return issueSessionForIdentity(identity.id, user.id);
}

/** Valida un reto de canal guardado en BD (intentos, caducidad, un solo uso). */
async function checkChannelChallenge(
  jti: string,
  kind: ChannelChallengeKind,
  externalUserId: string,
) {
  const ch = await prisma.channelLoginChallenge.findUnique({ where: { jti } });
  if (!ch || ch.kind !== kind || ch.externalUserId !== externalUserId) throw invalidGrant();
  if (ch.consumedAt) throw invalidGrant();
  if (ch.expiresAt <= new Date()) throw new AppError(410, 'El código ha caducado', 'EXPIRED_TOKEN');
  if (ch.attempts >= MAX_CHALLENGE_ATTEMPTS) throw new AppError(410, 'Demasiados intentos. Vuelve a empezar.', 'EXPIRED_TOKEN');
  return ch;
}

async function consumeChannelChallenge(id: string): Promise<void> {
  const { count } = await prisma.channelLoginChallenge.updateMany({ where: { id, consumedAt: null }, data: { consumedAt: new Date() } });
  if (count === 0) throw invalidGrant();
}

async function failChannelChallenge(id: string): Promise<number> {
  const updated = await prisma.channelLoginChallenge.update({ where: { id }, data: { attempts: { increment: 1 } } });
  return Math.max(0, MAX_CHALLENGE_ATTEMPTS - updated.attempts);
}

/** Si la cuenta tiene MFA, el primer factor solo da derecho a un reto (CA-22). */
async function mfaGateOrSession(userId: string, input: { channel: ApiChannel; externalUserId: string }, displayName: string, via: string): Promise<TokenGrantResult> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { mfaEnabled: true } });
  if (user.mfaEnabled) {
    const { token: challengeToken, jti } = signPurposeToken('channel_mfa', input.externalUserId, CHANNEL_MFA_TTL_SECONDS, { dn: displayName });
    await prisma.channelLoginChallenge.create({
      data: {
        jti,
        kind: ChannelChallengeKind.MFA,
        channel: toDbChannel(input.channel),
        externalUserId: input.externalUserId,
        userId,
        expiresAt: new Date(Date.now() + CHANNEL_MFA_TTL_SECONDS * 1000),
      },
    });
    return { mfaRequired: true, challengeToken, expiresIn: CHANNEL_MFA_TTL_SECONDS, methods: ['xotp', 'recovery_code'] };
  }
  return openChannelSession(userId, toDbChannel(input.channel), input.externalUserId, displayName, via);
}

async function grantEmailOtp(input: Extract<TokenGrantInput, { grant_type: 'email_otp' }>): Promise<TokenGrantResult> {
  const payload = decodeChallenge(input.challengeToken, 'channel_email_otp');
  if (payload.sub !== input.externalUserId) throw invalidGrant();
  const ch = await checkChannelChallenge(payload.jti, ChannelChallengeKind.EMAIL_OTP, input.externalUserId);

  // Con userId nulo se compara igualmente para no distinguir por tiempo
  const ok = ch.otpHash ? await verifyOtpCode(input.code, ch.otpHash) : (await verifyPassword(input.code, null), false);
  if (!ok || !ch.userId) {
    const remaining = await failChannelChallenge(ch.id);
    throw new AppError(400, 'Código incorrecto', 'INVALID_GRANT', { remainingAttempts: remaining });
  }
  await consumeChannelChallenge(ch.id);

  const user = await loadActiveUser(ch.userId);
  const identity = await prisma.channelIdentity.findFirst({
    where: { channel: ch.channel, externalUserId: input.externalUserId, revokedAt: null },
  });
  if (identity && identity.userId !== user.id) {
    throw new AppError(409, 'Esta cuenta de Telegram ya está vinculada a otro usuario', 'CHANNEL_IDENTITY_TAKEN');
  }
  const displayName = identity?.displayName ?? user.name;
  return mfaGateOrSession(user.id, input, displayName, 'email_otp');
}

async function grantRegistrationOtp(input: Extract<TokenGrantInput, { grant_type: 'registration_otp' }>): Promise<IssuedChannelSession> {
  const payload = decodeChallenge(input.challengeToken, 'channel_register');
  if (payload.ext !== input.externalUserId) throw invalidGrant();

  let created;
  try {
    created = await consumePendingRegistration(payload.jti, input.code, RegistrationOrigin.TELEGRAM);
  } catch (err) {
    if (err instanceof AppError && (err.code === 'INVALID_OTP' || err.code === 'NOT_FOUND')) {
      throw new AppError(400, err.message, 'INVALID_GRANT', err.details);
    }
    throw err;
  }
  if (created.pending.externalUserId !== input.externalUserId) throw invalidGrant();
  return openChannelSession(created.user.id, toDbChannel(input.channel), input.externalUserId, created.user.name, 'registration');
}

async function grantMfa(input: Extract<TokenGrantInput, { grant_type: 'mfa' }>, ctx: { clientIp?: string }): Promise<IssuedChannelSession> {
  const payload = decodeChallenge(input.challengeToken, 'channel_mfa');
  if (payload.sub !== input.externalUserId) throw invalidGrant();
  const ch = await checkChannelChallenge(payload.jti, ChannelChallengeKind.MFA, input.externalUserId);
  if (!ch.userId) throw invalidGrant();

  try {
    await verifySecondFactor({
      userId: ch.userId,
      code: input.code,
      recoveryCode: input.recoveryCode,
      purpose: 'channel_login',
      correlationId: payload.jti,
      clientIp: ctx.clientIp,
      challengeRemaining: MAX_CHALLENGE_ATTEMPTS - ch.attempts - 1,
    });
  } catch (err) {
    if (err instanceof AppError && err.code === 'MFA_INVALID_CODE') {
      const remaining = await failChannelChallenge(ch.id);
      logAction({ userId: ch.userId, action: 'LOGIN_MFA_FAILED', payload: { client: 'channel', channel: 'telegram', reason: String(err.details?.reason ?? 'INVALID_CODE') } }).catch(console.error);
      const mfaRemaining = err.details?.remainingAttempts as number | undefined;
      throw new AppError(401, err.message, err.code, { ...err.details, remainingAttempts: Math.min(remaining, mfaRemaining ?? remaining) });
    }
    throw err;
  }
  await consumeChannelChallenge(ch.id);

  const user = await loadActiveUser(ch.userId);
  const displayName = typeof payload.dn === 'string' ? payload.dn : user.name;
  return openChannelSession(user.id, ch.channel, input.externalUserId, displayName, 'mfa');
}

// ── EP-C-09: revocación desde el canal ────────────────────────

export async function revokeFromChannel(userId: string, sessionId: string, scope: 'session' | 'identity') {
  if (scope === 'session') {
    await revokeSession(sessionId, 'USER');
    return;
  }
  const s = await identityOfSession(sessionId);
  if (!s) return;
  await revokeIdentity(s.identityId, 'USER');
  logAction({ userId, action: 'CHANNEL_UNLINKED', payload: { client: 'channel', channel: 'telegram', identityId: s.identityId } }).catch(console.error);
}

// ── EP-C-11: desvincular desde la web ─────────────────────────

export async function unlinkFromWeb(userId: string, identityId: string) {
  const identity = await prisma.channelIdentity.findFirst({ where: { id: identityId, userId, revokedAt: null } });
  if (!identity) throw new AppError(404, 'Vinculación no encontrada', 'NOT_FOUND');
  await revokeIdentity(identityId, 'USER');
  logAction({ userId, action: 'CHANNEL_UNLINKED', payload: { client: 'web', channel: 'telegram', identityId } }).catch(console.error);
}
