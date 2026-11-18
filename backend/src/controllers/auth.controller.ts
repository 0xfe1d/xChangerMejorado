import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import geoip from 'geoip-lite';
import { env } from '../config/env';
import { durationToMs } from '../utils/duration';
import * as authService from '../services/auth.service';
import { createNotification } from '../services/notification.service';
import { AppError } from '../middleware/errorHandler';
import { REAUTH_VALIDITY_SECONDS } from '../middleware/authenticate';

// ── Helpers de geolocalización ────────────────────────────────

/** Normaliza IPv4 mapeado sobre IPv6 (::ffff:x.x.x.x → x.x.x.x) */
export function normalizeIp(raw: string): string {
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}

/** AR-02: la IP la resuelve Express con trust proxy (no se lee X-Forwarded-For a mano). */
export function clientIp(req: Request): string {
  return normalizeIp(req.ip ?? req.socket.remoteAddress ?? 'Desconocida');
}

function lookupLocation(ip: string): string {
  const clean = normalizeIp(ip);
  if (clean === '::1' || clean === '127.0.0.1' || clean.startsWith('192.168.') || clean.startsWith('10.') || clean.startsWith('172.')) {
    return 'Red local';
  }
  const geo = geoip.lookup(clean);
  if (!geo) return 'Ubicación desconocida';
  return [geo.city, geo.region, geo.country].filter(Boolean).join(', ');
}

// ── Esquemas de validación ────────────────────────────────────

const registerSchema = z.object({
  email: z.string().email(),
  name: z.string().trim().min(2).max(100),
  password: z.string().min(8),
  carreraId: z.string().cuid(),
  cursoId: z.string().cuid(),
});

const otpSchema = z.string().regex(/^\d{6}$/, 'El código debe tener 6 dígitos');
const verifyOtpSchema = z.object({ otpCode: otpSchema });

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  rememberMe: z.boolean().optional(),
});

const mfaChallengeSchema = z.object({
  code: z.string().max(20).optional(),
  recoveryCode: z.string().max(20).optional(),
});

const reauthSchema = z.object({
  password: z.string().min(1).optional(),
  code: z.string().max(20).optional(),
  method: z.enum(['password', 'email_otp']).optional(),
});

// ── CookieSessionIssuer (§5.3) ────────────────────────────────

// Caducidad de las cookies = caducidad de los JWT configurada en .env
const ACCESS_COOKIE_MS = durationToMs(env.JWT_ACCESS_EXPIRES_IN)!;
const REMEMBER_COOKIE_MS = durationToMs(env.JWT_REFRESH_REMEMBER_EXPIRES_IN)!;

const COOKIE_DEFAULTS = {
  httpOnly: true,
  secure: env.COOKIE_SECURE,
  sameSite: 'lax' as const,
  path: '/',
};

/** Ruta de la cookie de refresco: la del prefijo por el que entró la petición (/api o /api/v1). */
const refreshPath = (req: Request) => `${req.baseUrl}/refresh`;
const challengePath = (req: Request) => `${req.baseUrl}/mfa/challenge`;

/**
 * Sin "recordar", las cookies son de sesión del navegador (se borran al cerrarlo)
 * y el refresh dura JWT_REFRESH_EXPIRES_IN. Con "recordar", la cookie de refresco
 * persiste JWT_REFRESH_REMEMBER_EXPIRES_IN (30 días por defecto).
 */
export function setAuthCookies(req: Request, res: Response, accessToken: string, refreshToken: string, remember = false): void {
  setAccessCookie(res, accessToken, remember);
  // RF-AUT-11: el refresh token solo viaja al endpoint de renovación
  res.cookie('refresh_token', refreshToken, {
    ...COOKIE_DEFAULTS,
    path: refreshPath(req),
    ...(remember ? { maxAge: REMEMBER_COOKIE_MS } : {}),
  });
}

function setAccessCookie(res: Response, accessToken: string, remember = false): void {
  res.cookie('access_token', accessToken, { ...COOKIE_DEFAULTS, ...(remember ? { maxAge: ACCESS_COOKIE_MS } : {}) });
}


function clearAuthCookies(req: Request, res: Response): void {
  res.clearCookie('access_token', { ...COOKIE_DEFAULTS });
  // Se limpian ambos prefijos por si la sesión se abrió por el otro
  for (const p of ['/api/auth/refresh', '/api/v1/auth/refresh', refreshPath(req)]) {
    res.clearCookie('refresh_token', { ...COOKIE_DEFAULTS, path: p });
  }
}

/** Historial de acceso y aviso de seguridad tras un login completo (RF-AUT-17). */
function afterWebLogin(req: Request, userId: string): void {
  const ip = clientIp(req);
  const location = lookupLocation(ip);
  const userAgent = req.headers['user-agent'] ?? 'Desconocido';
  const now = new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' });
  authService.recordLogin(userId, ip, location, userAgent).catch((err) => console.error('[auth] error guardando LoginHistory:', err));
  createNotification({
    userId,
    asunto: 'Nuevo inicio de sesión en tu cuenta',
    contenido: `Se ha iniciado sesión en tu cuenta el ${now}.\nIP: ${ip}\nUbicación aproximada: ${location}\n\nSi no fuiste tú, cambia tu contraseña inmediatamente.`,
    kind: 'SECURITY',
  }).catch((err) => console.error('[auth] error creando notificación de login:', err));
}

// ── Controladores ─────────────────────────────────────────────

/** POST /auth/register — inicia el alta; JWT temporal en cookie HttpOnly. */
export async function register(req: Request, res: Response, next: NextFunction): Promise<void> {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) return next(new AppError(400, parsed.error.errors[0].message));
  try {
    const otpToken = await authService.register(parsed.data);
    res.cookie('otp_token', otpToken, { ...COOKIE_DEFAULTS, maxAge: 30 * 60 * 1000 });
    res.status(202).json({ message: 'Código OTP enviado a tu email. Tienes 30 minutos para verificarlo.' });
  } catch (err) {
    next(err);
  }
}

/** POST /auth/verify-otp — valida el OTP, crea la cuenta e inicia sesión. */
export async function verifyOtp(req: Request, res: Response, next: NextFunction): Promise<void> {
  const parsed = verifyOtpSchema.safeParse(req.body);
  if (!parsed.success) return next(new AppError(400, parsed.error.errors[0].message));
  const otpToken = req.cookies?.otp_token as string | undefined;
  if (!otpToken) return next(new AppError(400, 'No se encontró el token de verificación. Inicia el registro de nuevo.'));
  try {
    const { accessToken, refreshToken } = await authService.verifyOtp({ otpToken, otpCode: parsed.data.otpCode });
    res.clearCookie('otp_token', COOKIE_DEFAULTS);
    setAuthCookies(req, res, accessToken, refreshToken, false);
    res.status(201).json({ message: 'Cuenta creada correctamente. Bienvenido/a a xChanger.' });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /auth/login (EP-C-19).
 * Sin MFA: igual que antes. Con MFA: 200 mfaRequired + cookie mfa_challenge;
 * ninguna cookie de sesión se emite antes del segundo factor.
 */
export async function login(req: Request, res: Response, next: NextFunction): Promise<void> {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return next(new AppError(400, parsed.error.errors[0].message));
  try {
    const result = await authService.login(parsed.data);
    if (result.kind === 'mfa') {
      res.cookie('mfa_challenge', result.challengeToken, {
        ...COOKIE_DEFAULTS,
        sameSite: 'strict',
        path: challengePath(req),
        maxAge: result.expiresIn * 1000,
      });
      res.json({ mfaRequired: true, methods: ['xotp', 'recovery_code'], expiresIn: result.expiresIn });
      return;
    }
    setAuthCookies(req, res, result.accessToken, result.refreshToken, result.remember);
    afterWebLogin(req, result.user.id);
    res.json({ message: 'Sesión iniciada correctamente.' });
  } catch (err) {
    next(err);
  }
}

/** POST /auth/mfa/challenge (EP-C-24). */
export async function mfaChallenge(req: Request, res: Response, next: NextFunction): Promise<void> {
  const parsed = mfaChallengeSchema.safeParse(req.body);
  if (!parsed.success) return next(new AppError(400, parsed.error.errors[0].message));
  const token = req.cookies?.mfa_challenge as string | undefined;
  if (!token) return next(new AppError(410, 'El reto ha caducado. Vuelve a iniciar sesión.', 'MFA_CHALLENGE_EXPIRED'));
  try {
    const result = await authService.completeMfaChallenge(token, parsed.data, clientIp(req));
    res.clearCookie('mfa_challenge', { ...COOKIE_DEFAULTS, sameSite: 'strict', path: challengePath(req) });
    setAuthCookies(req, res, result.accessToken, result.refreshToken, result.remember);
    afterWebLogin(req, result.user.id);
    res.json({ user: result.user, ...(result.warnings.length ? { warnings: result.warnings } : {}) });
  } catch (err) {
    if (err instanceof AppError && err.code === 'MFA_CHALLENGE_EXPIRED') {
      res.clearCookie('mfa_challenge', { ...COOKIE_DEFAULTS, sameSite: 'strict', path: challengePath(req) });
    }
    next(err);
  }
}

/** POST /auth/refresh — renueva el Access Token con la cookie de refresco. */
export async function refresh(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = req.cookies?.refresh_token as string | undefined;
  if (!token) return next(new AppError(401, 'No existe sesión activa', 'SESSION_REVOKED'));
  try {
    const { accessToken, remember } = await authService.refreshToken(token);
    setAccessCookie(res, accessToken, remember);
    res.json({ message: 'Token renovado.' });
  } catch (err) {
    clearAuthCookies(req, res);
    next(err);
  }
}

/** POST /auth/logout — revoca el refresh token y limpia cookies. */
export async function logout(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (req.user) await authService.logout(req.user.sub);
    clearAuthCookies(req, res);
    res.json({ message: 'Sesión cerrada.' });
  } catch (err) {
    next(err);
  }
}

/** POST /auth/reauthenticate (EP-C-27). */
export async function reauthenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  const parsed = reauthSchema.safeParse(req.body);
  if (!parsed.success) return next(new AppError(400, parsed.error.errors[0].message));
  try {
    const result = await authService.reauthenticate(req.user!, parsed.data);
    if ('otpSent' in result) {
      res.status(202).json({ message: 'Te hemos enviado un código al correo.', codeLength: 6, expiresIn: 600 });
      return;
    }
    setAccessCookie(res, result.accessToken, req.user!.rem === true);
    res.json({ message: 'Identidad verificada.', reauthValidFor: REAUTH_VALIDITY_SECONDS });
  } catch (err) {
    next(err);
  }
}

/** GET /auth/me — identidad del usuario (EP-R-04, ahora con mfaEnabled). */
export async function me(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json(await authService.getProfile(req.user!.sub));
  } catch (err) {
    next(err);
  }
}

const updateMeSchema = z
  .object({
    name: z.string().trim().min(2).max(100).optional(),
    carreraId: z.string().cuid().nullable().optional(),
    cursoId: z.string().cuid().nullable().optional(),
  })
  .strict(); // RF-PER-01: el email no es modificable

/** PATCH /auth/me — nombre, carrera y curso. */
export async function updateMe(req: Request, res: Response, next: NextFunction): Promise<void> {
  const parsed = updateMeSchema.safeParse(req.body);
  if (!parsed.success) return next(new AppError(400, parsed.error.errors[0].message));
  try {
    res.json(await authService.updateProfile(req.user!.sub, parsed.data));
  } catch (err) {
    next(err);
  }
}

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});

/** PATCH /auth/settings/password */
export async function changePassword(req: Request, res: Response, next: NextFunction): Promise<void> {
  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) return next(new AppError(400, parsed.error.errors[0].message));
  try {
    await authService.changePassword(req.user!.sub, parsed.data.currentPassword, parsed.data.newPassword);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

// ── Forgot / Reset Password ───────────────────────────────────

const forgotPasswordSchema = z.object({ email: z.string().email() });

export async function forgotPassword(req: Request, res: Response, next: NextFunction): Promise<void> {
  const parsed = forgotPasswordSchema.safeParse(req.body);
  if (!parsed.success) return next(new AppError(400, parsed.error.errors[0].message));
  try {
    await authService.forgotPassword(parsed.data.email);
    res.json({ message: 'Si el email está registrado, recibirás un código de recuperación.' });
  } catch (err) {
    next(err);
  }
}

const resetPasswordSchema = z.object({
  email: z.string().email(),
  otpCode: otpSchema,
  newPassword: z.string().min(8),
});

export async function resetPassword(req: Request, res: Response, next: NextFunction): Promise<void> {
  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) return next(new AppError(400, parsed.error.errors[0].message));
  try {
    await authService.resetPassword(parsed.data.email, parsed.data.otpCode, parsed.data.newPassword);
    res.json({ message: 'Contraseña actualizada. Ya puedes iniciar sesión.' });
  } catch (err) {
    next(err);
  }
}
