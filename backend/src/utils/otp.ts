import crypto from 'crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';

const OTP_DIGITS = 6;
const BCRYPT_COST = 10;

/** Genera un código OTP numérico de 6 dígitos criptográficamente seguro */
export function generateOtpCode(): string {
  // Rango [0, 999999]; se zero-padea para garantizar 6 dígitos
  const raw = crypto.randomInt(0, 10 ** OTP_DIGITS);
  return raw.toString().padStart(OTP_DIGITS, '0');
}

export async function hashOtpCode(code: string): Promise<string> {
  return bcrypt.hash(code, BCRYPT_COST);
}

export async function verifyOtpCode(code: string, hash: string): Promise<boolean> {
  return bcrypt.compare(code, hash);
}

export interface OtpTokenPayload {
  sub: string;   // email del registro pendiente
  jti: string;   // ID único que se guarda en PendingRegistration
  purpose: 'otp_verify';
}

/** Emite el JWT de 30 min que encapsula el flujo de registro OTP */
export function signOtpToken(email: string): { token: string; jti: string } {
  const jti = crypto.randomUUID();
  const token = jwt.sign(
    { sub: email, purpose: 'otp_verify' } satisfies Omit<OtpTokenPayload, 'jti'>,
    env.JWT_ACCESS_SECRET,
    { expiresIn: env.JWT_OTP_EXPIRES_IN as jwt.SignOptions['expiresIn'], jwtid: jti },
  );
  return { token, jti };
}

/** Verifica el JWT OTP y devuelve su payload o lanza error */
export function verifyOtpToken(token: string): OtpTokenPayload {
  const payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as OtpTokenPayload;
  if (payload.purpose !== 'otp_verify') {
    throw new Error('Token no válido para verificación OTP');
  }
  return payload;
}

// ── Tokens de propósito específico (retos efímeros) ───────────

export type TokenPurpose = 'otp_verify' | 'mfa_challenge' | 'channel_email_otp' | 'channel_register' | 'channel_mfa';

export interface PurposeTokenPayload {
  sub: string;
  jti: string;
  purpose: TokenPurpose;
  [claim: string]: unknown;
}

/** JWT de un solo propósito, ligado a un jti que el servidor registra y consume. */
export function signPurposeToken(
  purpose: TokenPurpose,
  sub: string,
  ttlSeconds: number,
  extra: Record<string, unknown> = {},
): { token: string; jti: string } {
  const jti = crypto.randomUUID();
  const token = jwt.sign({ ...extra, sub, purpose }, env.JWT_ACCESS_SECRET, { expiresIn: ttlSeconds, jwtid: jti, algorithm: 'HS256' });
  return { token, jti };
}

/** Lanza TokenExpiredError si caducó o Error si no es del propósito pedido. */
export function verifyPurposeToken(token: string, purpose: TokenPurpose): PurposeTokenPayload {
  const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'] }) as PurposeTokenPayload;
  if (payload.purpose !== purpose || !payload.jti) throw new Error('Token de propósito incorrecto');
  return payload;
}
