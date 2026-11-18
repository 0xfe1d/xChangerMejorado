import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { RegistrationOrigin, Role, User } from '@prisma/client';

import { env } from '../config/env';
import { getRedis } from '../config/redis';
import { AppError } from '../middleware/errorHandler';
import { AccessTokenPayload } from '../middleware/authenticate';
import { validatePasswordComplexity, hashPassword, verifyPassword } from '../utils/password';
import {
  generateOtpCode,
  hashOtpCode,
  verifyOtpCode,
  signOtpToken,
  verifyOtpToken,
  signPurposeToken,
  verifyPurposeToken,
} from '../utils/otp';
import { sendOtpEmail } from './email.service';
import { prisma } from '../config/prisma';
import { logAction } from './log.service';
import { liftExpiredBlock, accountBlockedError } from './account-state.service';
import {
  findUserByEmail,
  findUserById,
  createUser,
  createPendingRegistration,
  findPendingRegistrationByJti,
  deletePendingRegistration,
  updateRefreshTokenHash,
  updatePasswordHash,
} from '../repositories/user.repository';
import { verifySecondFactor } from './mfa/second-factor';
import * as challengeStore from './mfa/mfa-challenge.store';

export const INSTITUTIONAL_DOMAIN = '@alumnos.unican.es';

// ── Tipos de entrada ──────────────────────────────────────────

export interface RegisterInput {
  email: string;
  name: string;
  /** Obligatoria salvo en altas desde un canal (ADR-29). */
  password?: string;
  carreraId: string;
  cursoId: string;
  origin?: RegistrationOrigin;
  externalUserId?: string;
}

export interface VerifyOtpInput {
  otpToken: string;
  otpCode: string;
}

export interface LoginInput {
  email: string;
  password: string;
  /** "Recordar inicio de sesión": refresh de JWT_REFRESH_REMEMBER_EXPIRES_IN. */
  rememberMe?: boolean;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  /** La sesión es persistente (cookie con caducidad) en vez de cookie de sesión del navegador. */
  remember: boolean;
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export type LoginResult =
  | ({ kind: 'session'; user: SessionUser } & AuthTokens)
  | { kind: 'mfa'; challengeToken: string; expiresIn: number };

// ── Helpers de tokens ─────────────────────────────────────────

const nowSeconds = () => Math.floor(Date.now() / 1000);

function signAccessToken(payload: Omit<AccessTokenPayload, 'jti'>): string {
  return jwt.sign({ ...payload, jti: crypto.randomUUID() }, env.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    expiresIn: env.JWT_ACCESS_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  });
}

function signRefreshToken(userId: string, authTime: number, remember: boolean): string {
  // jti aleatorio para que dos sesiones emitidas en el mismo segundo no coincidan
  return jwt.sign({ sub: userId, auth_time: authTime, ...(remember ? { rem: true } : {}) }, env.JWT_REFRESH_SECRET, {
    algorithm: 'HS256',
    expiresIn: (remember ? env.JWT_REFRESH_REMEMBER_EXPIRES_IN : env.JWT_REFRESH_EXPIRES_IN) as jwt.SignOptions['expiresIn'],
    jwtid: crypto.randomUUID(),
  });
}

/**
 * Emite la sesión web (CookieSessionIssuer, §5.3, lo convierte en cookies).
 * RF-AUT-12: solo se guarda el hash bcrypt del refresh token.
 */
export async function issueWebSession(
  user: Pick<User, 'id' | 'email' | 'role'>,
  authTime = nowSeconds(),
  remember = false,
): Promise<AuthTokens> {
  const accessToken = signAccessToken({ sub: user.id, email: user.email, role: user.role, auth_time: authTime, ...(remember ? { rem: true } : {}) });
  const refreshToken = signRefreshToken(user.id, authTime, remember);
  await updateRefreshTokenHash(user.id, await hashPassword(refreshToken));
  return { accessToken, refreshToken, remember };
}

function assertInstitutionalEmail(email: string): void {
  if (!email.toLowerCase().endsWith(INSTITUTIONAL_DOMAIN)) {
    throw new AppError(400, `El email debe ser una cuenta ${INSTITUTIONAL_DOMAIN}`, 'INVALID_EMAIL_DOMAIN');
  }
}

// ── Registro (reutilizado por web y canal) ────────────────────

/**
 * Fase 1 del alta (RF-AUT-01..06). Valida, crea el PendingRegistration y
 * envía el OTP. Devuelve el JWT de reto y su jti.
 *  · origin=WEB       → JWT otp_verify en cookie (contrato actual)
 *  · origin=TELEGRAM  → JWT channel_register en el cuerpo, sin contraseña (ADR-29)
 */
export async function registerPending(input: RegisterInput): Promise<{ token: string; jti: string }> {
  const email = input.email.toLowerCase();
  const origin = input.origin ?? RegistrationOrigin.WEB;
  assertInstitutionalEmail(email);

  if (await findUserByEmail(email)) {
    throw new AppError(409, 'Ya existe una cuenta con ese email', 'EMAIL_TAKEN');
  }

  // Carrera y curso existentes, no eliminados y coherentes entre sí
  const curso = await prisma.curso.findFirst({
    where: { id: input.cursoId, carreraId: input.carreraId, deletedAt: null, carrera: { deletedAt: null } },
  });
  if (!curso) throw new AppError(400, 'La carrera o el curso indicados no son válidos', 'VALIDATION_ERROR');

  let passwordHash: string | null = null;
  if (origin === RegistrationOrigin.WEB) {
    if (!input.password) throw new AppError(400, 'La contraseña es obligatoria', 'VALIDATION_ERROR');
    try {
      validatePasswordComplexity(input.password);
    } catch (e) {
      throw new AppError(400, (e as Error).message, 'WEAK_PASSWORD');
    }
    passwordHash = await hashPassword(input.password);
  } else if (!input.externalUserId) {
    throw new AppError(400, 'Falta la identidad del canal', 'VALIDATION_ERROR');
  }

  const otpCode = generateOtpCode();
  const otpCodeHash = await hashOtpCode(otpCode);
  const { token, jti } =
    origin === RegistrationOrigin.WEB
      ? signOtpToken(email)
      : signPurposeToken('channel_register', email, 30 * 60, { ext: input.externalUserId });

  await createPendingRegistration({
    email,
    name: input.name,
    passwordHash,
    carreraId: input.carreraId,
    cursoId: input.cursoId,
    otpCodeHash,
    jwtJti: jti,
    origin,
    externalUserId: input.externalUserId ?? null,
    expiresAt: new Date(Date.now() + 30 * 60 * 1000),
  });

  // RF-AUT-05: un fallo de envío se registra sin revelar detalles al cliente
  await sendOtpEmail(email, otpCode).catch((err) => console.error('[email] error enviando OTP:', err));
  return { token, jti };
}

/** Compatibilidad: firma anterior que devolvía solo el token. */
export async function register(input: RegisterInput): Promise<string> {
  return (await registerPending({ ...input, origin: RegistrationOrigin.WEB })).token;
}

const MAX_REGISTRATION_OTP_ATTEMPTS = 5;

/**
 * Comprueba el OTP de un registro pendiente y crea el usuario definitivo
 * (RF-AUT-07/08). Común a web y canal. Límite de intentos por reto en Redis.
 */
export async function consumePendingRegistration(jti: string, otpCode: string, expectedOrigin: RegistrationOrigin) {
  const pending = await findPendingRegistrationByJti(jti);
  if (!pending || pending.origin !== expectedOrigin) {
    throw new AppError(404, 'No existe un registro pendiente para este token', 'NOT_FOUND');
  }
  if (pending.expiresAt < new Date()) {
    await deletePendingRegistration(pending.email).catch(() => undefined);
    throw new AppError(410, 'El código OTP ha expirado. Inicia el registro de nuevo.', 'EXPIRED_TOKEN');
  }

  const attemptsKey = `reg:attempts:${jti}`;
  const attempts = await getRedis().incr(attemptsKey);
  if (attempts === 1) await getRedis().expire(attemptsKey, 30 * 60);
  if (attempts > MAX_REGISTRATION_OTP_ATTEMPTS) {
    await deletePendingRegistration(pending.email).catch(() => undefined);
    throw new AppError(410, 'Demasiados intentos. Inicia el registro de nuevo.', 'EXPIRED_TOKEN');
  }

  if (!(await verifyOtpCode(otpCode, pending.otpCodeHash))) {
    throw new AppError(400, 'Código OTP incorrecto', 'INVALID_OTP', { remainingAttempts: MAX_REGISTRATION_OTP_ATTEMPTS - attempts });
  }

  const user = await createUser({
    email: pending.email,
    name: pending.name,
    passwordHash: pending.passwordHash,
    carreraId: pending.carreraId,
    cursoId: pending.cursoId,
    asignaturaIds: [], // el usuario elige su expediente después (RF-PER-03)
  });
  await deletePendingRegistration(pending.email);
  await getRedis().del(attemptsKey);

  logAction({ userId: user.id, action: 'REGISTER', payload: { email: user.email, origin: pending.origin } }).catch(console.error);
  return { user, pending };
}

/** Fase 2 del alta web: valida el JWT otp_verify y crea la cuenta con sesión. */
export async function verifyOtp(input: VerifyOtpInput): Promise<AuthTokens> {
  let jti: string;
  try {
    jti = verifyOtpToken(input.otpToken).jti;
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      throw new AppError(410, 'El código OTP ha expirado. Inicia el registro de nuevo.', 'EXPIRED_TOKEN');
    }
    throw new AppError(401, 'Token de verificación inválido o expirado', 'INVALID_TOKEN');
  }
  const { user } = await consumePendingRegistration(jti, input.otpCode, RegistrationOrigin.WEB);
  return issueWebSession(user);
}

// ── Login (EP-C-19) ───────────────────────────────────────────

export async function login(input: LoginInput): Promise<LoginResult> {
  const user = await findUserByEmail(input.email.toLowerCase());

  // RF-AUT-09: misma respuesta y coste si el email no existe o no tiene contraseña
  const passwordValid = await verifyPassword(input.password, user?.passwordHash ?? null);
  if (!user || !passwordValid) throw new AppError(401, 'Credenciales incorrectas', 'INVALID_CREDENTIALS');

  // §7.3: con MFA, el estado de bloqueo solo se revela tras ambos factores
  if (user.mfaEnabled) {
    const { token, jti } = signPurposeToken('mfa_challenge', user.id, challengeStore.MFA_CHALLENGE_TTL_SECONDS);
    await challengeStore.createChallenge(jti, user.id, input.rememberMe === true);
    return { kind: 'mfa', challengeToken: token, expiresIn: challengeStore.MFA_CHALLENGE_TTL_SECONDS };
  }

  await assertNotBlocked(user);
  const tokens = await issueWebSession(user, undefined, input.rememberMe === true);
  return { kind: 'session', ...tokens, user: { id: user.id, email: user.email, name: user.name, role: user.role } };
}

async function assertNotBlocked(user: User): Promise<void> {
  const role = await liftExpiredBlock(user);
  if (role === Role.BLOQUEADO) {
    logAction({
      userId: user.id,
      action: 'LOGIN_BLOCKED',
      payload: { email: user.email, permanent: user.blockedUntil === null, blockedUntil: user.blockedUntil?.toISOString() ?? null },
    }).catch(console.error);
    throw accountBlockedError(user);
  }
  user.role = role;
}

export interface MfaChallengeResult extends AuthTokens {
  user: SessionUser;
  method: 'xotp' | 'recovery_code';
  warnings: string[];
}

/** EP-C-24: segundo paso del login web. */
export async function completeMfaChallenge(
  challengeToken: string,
  factor: { code?: string; recoveryCode?: string },
  clientIp?: string,
): Promise<MfaChallengeResult> {
  let payload;
  try {
    payload = verifyPurposeToken(challengeToken, 'mfa_challenge');
  } catch {
    throw new AppError(410, 'El reto ha caducado. Vuelve a iniciar sesión.', 'MFA_CHALLENGE_EXPIRED');
  }
  const state = await challengeStore.getChallenge(payload.jti);
  if (!state || state.userId !== payload.sub) {
    throw new AppError(410, 'El reto ha caducado. Vuelve a iniciar sesión.', 'MFA_CHALLENGE_EXPIRED');
  }

  let result;
  try {
    result = await verifySecondFactor({
      userId: payload.sub,
      ...factor,
      purpose: 'login',
      correlationId: payload.jti,
      clientIp,
      challengeRemaining: MFA_CHALLENGE_REMAINING(state.attempts) - 1,
    });
  } catch (err) {
    if (err instanceof AppError && err.code === 'MFA_INVALID_CODE') {
      const remaining = await challengeStore.registerFailure(payload.jti);
      logAction({ userId: payload.sub, action: 'LOGIN_MFA_FAILED', payload: { client: 'web', reason: String(err.details?.reason ?? 'INVALID_CODE') } }).catch(console.error);
      const mfaRemaining = err.details?.remainingAttempts as number | undefined;
      throw new AppError(401, err.message, err.code, {
        ...err.details,
        remainingAttempts: Math.min(remaining, mfaRemaining ?? remaining),
      });
    }
    throw err;
  }

  if (!(await challengeStore.consumeChallenge(payload.jti))) {
    throw new AppError(410, 'El reto ya se ha utilizado', 'MFA_CHALLENGE_EXPIRED');
  }

  const user = await findUserById(payload.sub);
  if (!user) throw new AppError(401, 'Credenciales incorrectas', 'INVALID_CREDENTIALS');
  await assertNotBlocked(user);

  const tokens = await issueWebSession(user, undefined, state.remember === true);
  const warnings: string[] = [];
  if (result.driftWarning) warnings.push('CLOCK_DRIFT');
  if (result.recoveryCodesRemaining !== undefined && result.recoveryCodesRemaining <= 2) warnings.push('RECOVERY_CODES_LOW');
  return { ...tokens, user: { id: user.id, email: user.email, name: user.name, role: user.role }, method: result.method, warnings };
}

const MFA_CHALLENGE_REMAINING = (attempts: number) => challengeStore.MFA_CHALLENGE_MAX_ATTEMPTS - attempts;

// ── Refresh ───────────────────────────────────────────────────

interface RefreshPayload {
  sub: string;
  auth_time?: number;
  rem?: boolean;
}

/**
 * Emite un nuevo Access Token si el Refresh Token coincide con el hash guardado.
 * Si el usuario está bloqueado, revoca la sesión (RF-AUT-12). Conserva auth_time
 * para que "sesión reciente" no se renueve con un simple refresco.
 */
export async function refreshToken(token: string): Promise<{ accessToken: string; remember: boolean }> {
  let payload: RefreshPayload;
  try {
    payload = jwt.verify(token, env.JWT_REFRESH_SECRET, { algorithms: ['HS256'] }) as RefreshPayload;
  } catch {
    throw new AppError(401, 'Refresh token inválido o expirado', 'INVALID_TOKEN');
  }

  const user = await findUserById(payload.sub);
  if (!user) throw new AppError(401, 'Usuario no encontrado', 'UNAUTHORIZED');

  if ((await liftExpiredBlock(user)) === Role.BLOQUEADO) {
    await updateRefreshTokenHash(user.id, null);
    throw new AppError(403, 'Tu cuenta está bloqueada. La sesión ha sido revocada.', 'ACCOUNT_BLOCKED');
  }
  if (!user.refreshTokenHash) throw new AppError(401, 'No existe sesión activa', 'SESSION_REVOKED');
  if (!(await verifyPassword(token, user.refreshTokenHash))) {
    throw new AppError(401, 'Refresh token no reconocido', 'SESSION_REVOKED');
  }

  const fresh = await findUserById(user.id);
  const remember = payload.rem === true;
  return {
    accessToken: signAccessToken({
      sub: user.id, email: user.email, role: fresh?.role ?? user.role, auth_time: payload.auth_time ?? 0, ...(remember ? { rem: true } : {}),
    }),
    remember,
  };
}

// ── Logout ────────────────────────────────────────────────────

export async function logout(userId: string): Promise<void> {
  await updateRefreshTokenHash(userId, null);
}

// ── Reautenticación (EP-C-27) ─────────────────────────────────

export interface ReauthInput {
  password?: string;
  code?: string;
  method?: 'password' | 'email_otp';
}

const REAUTH_OTP_TTL = 10 * 60;

/**
 * Prueba de presencia reciente. Devuelve un access token rotado con reauth_at,
 * o { otpSent: true } en el primer paso del método email_otp.
 */
export async function reauthenticate(principal: AccessTokenPayload, input: ReauthInput): Promise<{ accessToken: string } | { otpSent: true }> {
  const user = await findUserById(principal.sub);
  if (!user) throw new AppError(401, 'Credenciales incorrectas', 'INVALID_CREDENTIALS');

  if (input.method === 'email_otp') {
    // Solo para cuentas sin contraseña ni MFA (creadas desde un canal)
    if (user.passwordHash || user.mfaEnabled) throw new AppError(400, 'Usa tu contraseña para reautenticarte', 'VALIDATION_ERROR');
    const key = `reauth:otp:${user.id}`;
    if (!input.code) {
      const otp = generateOtpCode();
      await getRedis().set(key, JSON.stringify({ hash: await hashOtpCode(otp), attempts: 0 }), 'EX', REAUTH_OTP_TTL);
      await sendOtpEmail(user.email, otp).catch((err) => console.error('[auth] error enviando OTP de reautenticación:', err));
      return { otpSent: true };
    }
    const raw = await getRedis().get(key);
    const state = raw ? (JSON.parse(raw) as { hash: string; attempts: number }) : null;
    if (!state || state.attempts >= 5 || !(await verifyOtpCode(input.code, state.hash))) {
      if (state) await getRedis().set(key, JSON.stringify({ ...state, attempts: state.attempts + 1 }), 'KEEPTTL');
      throw new AppError(401, 'Credenciales incorrectas', 'INVALID_CREDENTIALS');
    }
    await getRedis().del(key);
  } else {
    if (user.passwordHash) {
      if (!input.password || !(await verifyPassword(input.password, user.passwordHash))) {
        throw new AppError(401, 'Credenciales incorrectas', 'INVALID_CREDENTIALS');
      }
    } else if (!user.mfaEnabled) {
      throw new AppError(400, 'Tu cuenta no tiene contraseña: usa method=email_otp', 'VALIDATION_ERROR');
    }
    if (user.mfaEnabled) {
      if (!input.code) throw new AppError(401, 'Se requiere el código de tu app', 'MFA_REQUIRED');
      await verifySecondFactor({ userId: user.id, code: input.code, purpose: 'reauth', correlationId: crypto.randomUUID() });
    }
  }

  return {
    accessToken: signAccessToken({
      sub: user.id,
      email: user.email,
      role: user.role,
      auth_time: principal.auth_time ?? 0,
      reauth_at: nowSeconds(),
      ...(principal.rem ? { rem: true } : {}),
    }),
  };
}

// ── Cambio de contraseña ──────────────────────────────────────

export async function changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
  const user = await findUserById(userId);
  if (!user) throw new AppError(404, 'Usuario no encontrado');
  if (!user.passwordHash) {
    throw new AppError(409, 'Tu cuenta no tiene contraseña. Fíjala con "He olvidado mi contraseña".', 'PASSWORD_NOT_SET');
  }
  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    throw new AppError(401, 'La contraseña actual es incorrecta', 'INVALID_CREDENTIALS');
  }
  try {
    validatePasswordComplexity(newPassword);
  } catch (e) {
    throw new AppError(400, (e as Error).message, 'WEAK_PASSWORD');
  }
  await updatePasswordHash(userId, await hashPassword(newPassword));
}

// ── Historial de accesos ──────────────────────────────────────

export async function recordLogin(userId: string, ip: string, location: string, userAgent: string): Promise<void> {
  await prisma.loginHistory.create({ data: { userId, ipAddress: ip, location, userAgent } });
}

// ── Recuperación de contraseña ────────────────────────────────

export async function forgotPassword(email: string): Promise<void> {
  const user = await findUserByEmail(email.toLowerCase());
  // RF-AUT-14: no revelar si el email existe
  if (!user) return;

  const otpCode = generateOtpCode();
  const otpCodeHash = await hashOtpCode(otpCode);
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

  // Una única solicitud activa por usuario
  await prisma.passwordResetRequest.deleteMany({ where: { userId: user.id } });
  await prisma.passwordResetRequest.create({ data: { userId: user.id, otpCodeHash, expiresAt } });

  await sendOtpEmail(user.email, otpCode).catch((err) => console.error('[auth] error enviando OTP de recuperación:', err));
}

/**
 * RF-AUT-15. También sirve para fijar contraseña en cuentas creadas desde un
 * canal (ADR-29). RF-MFA-11: no toca el segundo factor.
 */
export async function resetPassword(email: string, otpCode: string, newPassword: string): Promise<void> {
  const user = await findUserByEmail(email.toLowerCase());
  if (!user) throw new AppError(400, 'Solicitud de recuperación no válida');

  const request = await prisma.passwordResetRequest.findFirst({ where: { userId: user.id } });
  if (!request) throw new AppError(400, 'No hay una solicitud de recuperación activa para este email');
  if (request.expiresAt < new Date()) {
    await prisma.passwordResetRequest.delete({ where: { id: request.id } });
    throw new AppError(410, 'El código OTP ha expirado. Solicita uno nuevo.', 'EXPIRED_TOKEN');
  }
  if (!(await verifyOtpCode(otpCode, request.otpCodeHash))) throw new AppError(400, 'Código OTP incorrecto', 'INVALID_OTP');

  try {
    validatePasswordComplexity(newPassword);
  } catch (e) {
    throw new AppError(400, (e as Error).message, 'WEAK_PASSWORD');
  }
  await updatePasswordHash(user.id, await hashPassword(newPassword));
  await updateRefreshTokenHash(user.id, null); // revoca las sesiones web
  await prisma.passwordResetRequest.delete({ where: { id: request.id } });

  logAction({ userId: user.id, action: 'PASSWORD_RESET', payload: { email: user.email } }).catch(console.error);
}

// ── Perfil (AR-03: fuera del controlador) ─────────────────────

const PROFILE_SELECT = { id: true, email: true, role: true, name: true, carreraId: true, cursoId: true, mfaEnabled: true } as const;

export async function getProfile(userId: string) {
  return prisma.user.findFirst({ where: { id: userId, deletedAt: null }, select: PROFILE_SELECT });
}

export async function updateProfile(userId: string, data: { name?: string; carreraId?: string | null; cursoId?: string | null }) {
  if (data.cursoId) {
    const current = await prisma.user.findUnique({ where: { id: userId }, select: { carreraId: true } });
    const carreraId = data.carreraId ?? current?.carreraId;
    const ok = await prisma.curso.findFirst({ where: { id: data.cursoId, carreraId: carreraId ?? undefined, deletedAt: null } });
    if (!ok) throw new AppError(400, 'El curso no pertenece a la carrera indicada');
  }
  return prisma.user.update({ where: { id: userId }, data, select: PROFILE_SELECT });
}
