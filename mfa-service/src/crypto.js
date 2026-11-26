// Cifrado en reposo de los secretos TOTP con AES-256-GCM y una KEK del entorno.
// Los códigos de recuperación se guardan como SHA-256, nunca en claro.
import crypto from 'node:crypto';

let kek = null;

export function loadKek(hex) {
  if (!/^[0-9a-fA-F]{64}$/.test(hex ?? '')) {
    throw new Error('MFA_KEK debe ser una clave de 32 bytes en hexadecimal (64 caracteres). Genera con: openssl rand -hex 32');
  }
  kek = Buffer.from(hex, 'hex');
}

export function encryptSecret(secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', kek, iv);
  const ct = Buffer.concat([cipher.update(secret), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

export function decryptSecret(stored) {
  const [v, iv, tag, ct] = stored.split(':');
  if (v !== 'v1') throw new Error('Formato de secreto desconocido');
  const decipher = crypto.createDecipheriv('aes-256-gcm', kek, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]);
}

// Crockford Base32: sin I, L, O, U para evitar confusiones al copiar a mano
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function generateRecoveryCode() {
  const part = () => Array.from({ length: 5 }, () => CROCKFORD[crypto.randomInt(0, 32)]).join('');
  return `${part()}-${part()}`;
}

/** Normaliza lo que teclea el usuario: mayúsculas, sin guion, O→0, I/L→1. */
export function normalizeRecoveryCode(code) {
  return String(code).toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}

export function hashRecoveryCode(code) {
  return crypto.createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex');
}

export const newId = (prefix) => `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
