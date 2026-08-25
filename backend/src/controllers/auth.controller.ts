import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import geoip from 'geoip-lite';
import { env } from '../config/env';
import { prisma } from '../config/prisma';
import * as authService from '../services/auth.service';
import { createNotification } from '../services/notification.service';
import { AppError } from '../middleware/errorHandler';

// ── Helpers de geolocalización ────────────────────────────────

/** Extrae la IP real del cliente respetando proxies de confianza */
function extractIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return (Array.isArray(forwarded) ? forwarded[0] : forwarded).split(',')[0].trim();
  }
  return req.socket.remoteAddress ?? req.ip ?? 'Desconocida';
}

/** Normaliza IPv4 mapeado sobre IPv6 (::ffff:x.x.x.x → x.x.x.x) */
function normalizeIp(raw: string): string {
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}

function lookupLocation(ip: string): string {
  const clean = normalizeIp(ip);
  // Las IPs locales/privadas no tienen registro geográfico
  if (clean === '::1' || clean === '127.0.0.1' || clean.startsWith('192.168.') || clean.startsWith('10.')) {
    return 'Red local';
  }
  const geo = geoip.lookup(clean);
  if (!geo) return 'Ubicación desconocida';
  return [geo.city, geo.region, geo.country].filter(Boolean).join(', ');
}

// ── Esquemas de validación ────────────────────────────────────

const registerSchema = z.object({
  email: z.string().email(),
  name: z.string().min(2).max(100),
  password: z.string().min(8),
  carreraId: z.string().cuid(),
  cursoId: z.string().cuid(),
});

const verifyOtpSchema = z.object({
  otpCode: z.string().length(6).regex(/^\d{6}$/),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// ── Helpers de cookies ────────────────────────────────────────

const COOKIE_DEFAULTS = {
  httpOnly: true,
  secure: env.NODE_ENV === 'production',
  sameSite: 'strict' as const,
  path: '/',
};

function setAuthCookies(res: Response, accessToken: string, refreshToken: string): void {
  // Access Token: 15 min
  res.cookie('access_token', accessToken, {
    ...COOKIE_DEFAULTS,
    maxAge: 15 * 60 * 1000,
  });
  // Refresh Token: 7 días — solo accesible desde el endpoint /refresh
  res.cookie('refresh_token', refreshToken, {
    ...COOKIE_DEFAULTS,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/api/auth/refresh',
  });
}

function clearAuthCookies(res: Response): void {
  res.clearCookie('access_token', { ...COOKIE_DEFAULTS });
  res.clearCookie('refresh_token', { ...COOKIE_DEFAULTS, path: '/api/auth/refresh' });
}

// ── Controladores ─────────────────────────────────────────────

/**
 * POST /api/auth/register
 * Inicia el flujo OTP. Devuelve el JWT temporal en una cookie HttpOnly.
 */
export async function register(req: Request, res: Response, next: NextFunction): Promise<void> {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return next(new AppError(400, parsed.error.errors[0].message));
  }

  try {
    const otpToken = await authService.register(parsed.data);

    // JWT OTP en cookie temporal: expira en 30 min
    res.cookie('otp_token', otpToken, {
      ...COOKIE_DEFAULTS,
      maxAge: 30 * 60 * 1000,
    });

    res.status(202).json({ message: 'Código OTP enviado a tu email. Tienes 30 minutos para verificarlo.' });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/auth/verify-otp
 * Valida el código OTP y crea la cuenta. Establece cookies de sesión.
 */
export async function verifyOtp(req: Request, res: Response, next: NextFunction): Promise<void> {
  const parsed = verifyOtpSchema.safeParse(req.body);
  if (!parsed.success) {
    return next(new AppError(400, parsed.error.errors[0].message));
  }

  const otpToken = req.cookies?.otp_token as string | undefined;
  if (!otpToken) {
    return next(new AppError(400, 'No se encontró el token de verificación. Inicia el registro de nuevo.'));
  }

  try {
    const { accessToken, refreshToken } = await authService.verifyOtp({
      otpToken,
      otpCode: parsed.data.otpCode,
    });

    res.clearCookie('otp_token', COOKIE_DEFAULTS);
    setAuthCookies(res, accessToken, refreshToken);

    res.status(201).json({ message: 'Cuenta creada correctamente. Bienvenido/a a xChanger.' });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/auth/login
 * Autentica al usuario. Si está BLOQUEADO devuelve 403 con detalle.
 */
export async function login(req: Request, res: Response, next: NextFunction): Promise<void> {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return next(new AppError(400, parsed.error.errors[0].message));
  }

  try {
    const { accessToken, refreshToken, userId, userEmail } = await authService.login(parsed.data);
    setAuthCookies(res, accessToken, refreshToken);

    // Notificación de seguridad (DB + email) de forma no bloqueante
    const ip = extractIp(req);
    const location = lookupLocation(ip);
    const userAgent = req.headers['user-agent'] ?? 'Desconocido';
    const now = new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' });

    // Guardar historial de acceso y notificación (no bloqueante)
    authService.recordLogin(userId, ip, location, userAgent)
      .catch((err) => console.error('[auth] error guardando LoginHistory:', err));
    createNotification({
      userId,
      email: userEmail,
      asunto: 'Nuevo inicio de sesión en tu cuenta',
      contenido: `Se ha iniciado sesión en tu cuenta el ${now}.\nIP: ${ip}\nUbicación aproximada: ${location}\n\nSi no fuiste tú, cambia tu contraseña inmediatamente.`,
    }).catch((err) => console.error('[auth] error creando notificación de login:', err));

    res.json({ message: 'Sesión iniciada correctamente.' });
  } catch (err) {
    // Convertir el error de bloqueo a respuesta estructurada
    if (err instanceof AppError && err.statusCode === 403) {
      try {
        const detail = JSON.parse(err.message);
        res.status(403).json({ error: 'Cuenta bloqueada', detail });
        return;
      } catch {
        // El mensaje no era JSON; dejar que suba normalmente
      }
    }
    next(err);
  }
}

/**
 * POST /api/auth/refresh
 * Renueva el Access Token usando el Refresh Token de la cookie.
 */
export async function refresh(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = req.cookies?.refresh_token as string | undefined;
  if (!token) {
    return next(new AppError(401, 'No existe sesión activa'));
  }

  try {
    const accessToken = await authService.refreshToken(token);

    res.cookie('access_token', accessToken, {
      ...COOKIE_DEFAULTS,
      maxAge: 15 * 60 * 1000,
    });

    res.json({ message: 'Token renovado.' });
  } catch (err) {
    // Si el refresh falla, limpiar cookies para forzar login limpio
    clearAuthCookies(res);
    next(err);
  }
}

/**
 * POST /api/auth/logout
 * Revoca el refresh token y limpia cookies.
 */
export async function logout(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (req.user) {
      await authService.logout(req.user.sub);
    }
    clearAuthCookies(res);
    res.json({ message: 'Sesión cerrada.' });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/auth/me
 * Devuelve la identidad del usuario autenticado (para hidratación del frontend).
 */
export async function me(req: Request, res: Response): Promise<void> {
  const user = await prisma.user.findFirst({
    where: { id: req.user!.sub, deletedAt: null },
    select: { id: true, email: true, role: true, name: true, carreraId: true, cursoId: true },
  });
  res.json(user);
}

const updateMeSchema = z.object({
  name:      z.string().min(2).max(100).optional(),
  carreraId: z.string().cuid().nullable().optional(),
  cursoId:   z.string().cuid().nullable().optional(),
});

/**
 * PATCH /api/auth/me
 * Actualiza nombre, carrera y curso del usuario autenticado.
 */
export async function updateMe(req: Request, res: Response, next: NextFunction): Promise<void> {
  const parsed = updateMeSchema.safeParse(req.body);
  if (!parsed.success) {
    return next(new AppError(400, parsed.error.errors[0].message));
  }
  try {
    const updated = await prisma.user.update({
      where: { id: req.user!.sub },
      data: parsed.data,
      select: { id: true, email: true, role: true, name: true, carreraId: true, cursoId: true },
    });
    res.json(updated);
  } catch (err) {
    next(err);
  }
}

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword:     z.string().min(8),
});

/**
 * PATCH /api/auth/settings/password
 * Cambia la contraseña del usuario autenticado tras verificar la actual.
 */
export async function changePassword(req: Request, res: Response, next: NextFunction): Promise<void> {
  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return next(new AppError(400, parsed.error.errors[0].message));
  }
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
    // Respuesta genérica para no filtrar si el email existe
    res.json({ message: 'Si el email está registrado, recibirás un código de recuperación.' });
  } catch (err) {
    next(err);
  }
}

const resetPasswordSchema = z.object({
  email:       z.string().email(),
  otpCode:     z.string().length(6).regex(/^\d{6}$/),
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