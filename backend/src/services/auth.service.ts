import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { Role } from '@prisma/client';

import { env } from '../config/env';
import { AppError } from '../middleware/errorHandler';
import { AccessTokenPayload } from '../middleware/authenticate';
import { validatePasswordComplexity, hashPassword, verifyPassword } from '../utils/password';
import {
  generateOtpCode,
  hashOtpCode,
  verifyOtpCode,
  signOtpToken,
  verifyOtpToken,
} from '../utils/otp';
import { sendOtpEmail } from './email.service';
import { prisma } from '../config/prisma';
import { logAction } from './log.service';
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

// ── Tipos de entrada ──────────────────────────────────────────

export interface RegisterInput {
  email: string;
  name: string;
  password: string;
  carreraId: string;
  cursoId: string;
}

export interface VerifyOtpInput {
  otpToken: string;   // JWT de 30 min devuelto en /register
  otpCode: string;    // Código de 6 dígitos recibido por email
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface LoginResult extends AuthTokens {
  userId: string;
  userEmail: string;
}

// ── Helpers de tokens ─────────────────────────────────────────

function signAccessToken(payload: Omit<AccessTokenPayload, 'jti'>): string {
  const jti = crypto.randomUUID();
  return jwt.sign({ ...payload, jti }, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  });
}

function signRefreshToken(userId: string): string {
  return jwt.sign({ sub: userId }, env.JWT_REFRESH_SECRET, {
    expiresIn: env.JWT_REFRESH_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  });
}

// ── Flujo de Registro ─────────────────────────────────────────

/**
 * Fase 1 del registro:
 *  1. Valida email institucional y complejidad de contraseña.
 *  2. Genera OTP + JWT temporal de 30 min.
 *  3. Persiste PendingRegistration.
 *  4. Envía el código OTP por correo.
 * Devuelve el otpToken que debe guardarse en una cookie temporal HttpOnly.
 */
export async function register(input: RegisterInput): Promise<string> {
  const { email, name, password, carreraId, cursoId } = input;

  // Validar dominio institucional
  if (!email.endsWith('@alumnos.unican.es')) {
    throw new AppError(400, 'El email debe ser una cuenta @alumnos.unican.es');
  }

  // Comprobar unicidad antes de procesar
  const existing = await findUserByEmail(email);
  if (existing) {
    throw new AppError(409, 'Ya existe una cuenta con ese email');
  }

  // Validar complejidad de contraseña (lanza si no cumple)
  try {
    validatePasswordComplexity(password);
  } catch (e) {
    throw new AppError(400, (e as Error).message);
  }

  const passwordHash = await hashPassword(password);
  const otpCode = generateOtpCode();
  const otpCodeHash = await hashOtpCode(otpCode);
  const { token: otpToken, jti } = signOtpToken(email);

  // La expiración del registro pendiente coincide con la del JWT OTP
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

  await createPendingRegistration({
    email,
    name,
    passwordHash,
    carreraId,
    cursoId,
    otpCodeHash,
    jwtJti: jti,
    expiresAt,
  });

  // Envío asíncrono; no bloqueamos la respuesta si el email falla en dev
  await sendOtpEmail(email, otpCode).catch((err) => {
    console.error('[email] error enviando OTP:', err);
  });

  return otpToken;
}

// ── Flujo de Verificación OTP ─────────────────────────────────

/**
 * Fase 2 del registro:
 *  1. Verifica el JWT OTP.
 *  2. Localiza el PendingRegistration por jti.
 *  3. Comprueba expiración y validez del código.
 *  4. Crea el User definitivo y elimina el registro pendiente.
 *  5. Devuelve los tokens de sesión.
 */
export async function verifyOtp(input: VerifyOtpInput): Promise<AuthTokens> {
  const { otpToken, otpCode } = input;

  let jti: string;
  let email: string;

  try {
    const payload = verifyOtpToken(otpToken);
    jti = payload.jti;
    email = payload.sub;
  } catch {
    throw new AppError(401, 'Token de verificación inválido o expirado');
  }

  const pending = await findPendingRegistrationByJti(jti);

  if (!pending) {
    throw new AppError(404, 'No existe un registro pendiente para este token');
  }

  // Doble comprobación de expiración (el JWT ya lo hace, pero por defensa en profundidad)
  if (pending.expiresAt < new Date()) {
    await deletePendingRegistration(email);
    throw new AppError(410, 'El código OTP ha expirado. Inicia el registro de nuevo.');
  }

  const codeValid = await verifyOtpCode(otpCode, pending.otpCodeHash);
  if (!codeValid) {
    throw new AppError(400, 'Código OTP incorrecto');
  }

  // Crear el usuario definitivo
  const user = await createUser({
    email: pending.email,
    name: pending.name,
    passwordHash: pending.passwordHash,
    carreraId: pending.carreraId,
    cursoId: pending.cursoId,
    asignaturaIds: [], // El usuario completará su matrícula en el dashboard (requisito)
  });

  // Limpiar el registro temporal
  await deletePendingRegistration(pending.email);

  logAction({ userId: user.id, action: 'REGISTER', payload: { email: user.email } }).catch(console.error);

  const accessToken = signAccessToken({ sub: user.id, email: user.email, role: user.role });
  const refreshToken = signRefreshToken(user.id);

  // Guardar hash del refresh token para permitir revocación
  const refreshHash = await hashPassword(refreshToken);
  await updateRefreshTokenHash(user.id, refreshHash);

  return { accessToken, refreshToken };
}

// ── Flujo de Login ────────────────────────────────────────────

export async function login(input: LoginInput): Promise<LoginResult> {
  const { email, password } = input;

  const user = await findUserByEmail(email);

  // Respuesta genérica para no revelar si el email existe (timing-safe)
  if (!user) {
    // Ejecutar bcrypt igual para no filtrar por tiempo de respuesta
    await verifyPassword(password, '$2b$10$invalidhashpaddingtomatchtime000');
    throw new AppError(401, 'Credenciales incorrectas');
  }

  const passwordValid = await verifyPassword(password, user.passwordHash);
  if (!passwordValid) {
    throw new AppError(401, 'Credenciales incorrectas');
  }

  // El usuario existe y la contraseña es correcta: comprobar bloqueo
  if (user.role === Role.BLOQUEADO) {
    const isPermanent = user.blockedUntil === null;
    logAction({
      userId: user.id,
      action: 'LOGIN_BLOCKED',
      payload: { email: user.email, permanent: isPermanent, blockedUntil: user.blockedUntil?.toISOString() ?? null },
    }).catch(console.error);
    throw new AppError(403, JSON.stringify({
      blocked: true,
      permanent: isPermanent,
      blockedUntil: user.blockedUntil?.toISOString() ?? null,
      reason: user.blockReason ?? 'Sin motivo especificado',
    }));
  }

  const accessToken = signAccessToken({ sub: user.id, email: user.email, role: user.role });
  const refreshToken = signRefreshToken(user.id);

  const refreshHash = await hashPassword(refreshToken);
  await updateRefreshTokenHash(user.id, refreshHash);

  return { accessToken, refreshToken, userId: user.id, userEmail: user.email };
}

// ── Flujo de Refresh Token ────────────────────────────────────

export interface RefreshPayload {
  sub: string;
}

/**
 * Emite un nuevo Access Token si el Refresh Token es válido.
 * Si el usuario está BLOQUEADO, deniega la renovación forzando
 * el cierre de sesión al expirar el Access Token (máx. 15 min).
 */
export async function refreshToken(token: string): Promise<string> {
  let payload: RefreshPayload;

  try {
    payload = jwt.verify(token, env.JWT_REFRESH_SECRET) as RefreshPayload;
  } catch {
    throw new AppError(401, 'Refresh token inválido o expirado');
  }

  const user = await findUserById(payload.sub);

  if (!user) {
    throw new AppError(401, 'Usuario no encontrado');
  }

  if (user.role === Role.BLOQUEADO) {
    // Revocar el refresh token para forzar logout inmediato
    await updateRefreshTokenHash(user.id, null);
    throw new AppError(403, 'Tu cuenta está bloqueada. La sesión ha sido revocada.');
  }

  // Verificar que el refresh token coincide con el hash guardado
  if (!user.refreshTokenHash) {
    throw new AppError(401, 'No existe sesión activa');
  }

  const tokenValid = await verifyPassword(token, user.refreshTokenHash);
  if (!tokenValid) {
    throw new AppError(401, 'Refresh token no reconocido');
  }

  return signAccessToken({ sub: user.id, email: user.email, role: user.role });
}

// ── Logout ────────────────────────────────────────────────────

export async function logout(userId: string): Promise<void> {
  await updateRefreshTokenHash(userId, null);
}

// ── Cambio de contraseña ──────────────────────────────────────

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const user = await findUserById(userId);
  if (!user) throw new AppError(404, 'Usuario no encontrado');

  const valid = await verifyPassword(currentPassword, user.passwordHash);
  if (!valid) throw new AppError(401, 'La contraseña actual es incorrecta');

  validatePasswordComplexity(newPassword);
  const newHash = await hashPassword(newPassword);
  await updatePasswordHash(userId, newHash);
}
// ── Registro de acceso (LoginHistory) ────────────────────────

export async function recordLogin(
  userId: string,
  ip: string,
  location: string,
  userAgent: string,
): Promise<void> {
  await prisma.loginHistory.create({
    data: { userId, ipAddress: ip, location, userAgent },
  });
}

// ── Recuperación de contraseña ────────────────────────────────

export async function forgotPassword(email: string): Promise<void> {
  const user = await findUserByEmail(email);
  // No revelar si el email existe; siempre respuesta 200
  if (!user || user.deletedAt) return;

  const otpCode = generateOtpCode();
  const otpCodeHash = await hashOtpCode(otpCode);
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 min

  // Eliminar petición anterior si existe (una a la vez por usuario)
  await prisma.passwordResetRequest.deleteMany({ where: { userId: user.id } });
  await prisma.passwordResetRequest.create({
    data: { userId: user.id, otpCodeHash, expiresAt },
  });

  await sendOtpEmail(email, otpCode).catch((err) =>
    console.error('[auth] error enviando OTP de recuperación:', err),
  );
}

export async function resetPassword(
  email: string,
  otpCode: string,
  newPassword: string,
): Promise<void> {
  const user = await findUserByEmail(email);
  if (!user || user.deletedAt) throw new AppError(400, 'Solicitud de recuperación no válida');

  const request = await prisma.passwordResetRequest.findFirst({
    where: { userId: user.id },
  });

  if (!request) throw new AppError(400, 'No hay una solicitud de recuperación activa para este email');
  if (request.expiresAt < new Date()) {
    await prisma.passwordResetRequest.delete({ where: { id: request.id } });
    throw new AppError(410, 'El código OTP ha expirado. Solicita uno nuevo.');
  }

  const codeValid = await verifyOtpCode(otpCode, request.otpCodeHash);
  if (!codeValid) throw new AppError(400, 'Código OTP incorrecto');

  validatePasswordComplexity(newPassword);
  const newHash = await hashPassword(newPassword);
  await updatePasswordHash(user.id, newHash);

  // Revocar todas las sesiones activas tras el reset
  await updateRefreshTokenHash(user.id, null);
  await prisma.passwordResetRequest.delete({ where: { id: request.id } });

  logAction({ userId: user.id, action: 'PASSWORD_RESET', payload: { email } }).catch(console.error);
}