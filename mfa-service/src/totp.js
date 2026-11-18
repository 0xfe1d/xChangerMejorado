// TOTP según RFC 6238 / HOTP RFC 4226.
// Parámetros fijos compatibles con Microsoft Authenticator, Google Authenticator,
// Authy, 1Password, etc.: HMAC-SHA1, 6 dígitos, periodo de 30 s.
// (Microsoft Authenticator ignora algorithm/digits/period del QR y siempre usa
// SHA-1 / 6 / 30, por eso no se ofrecen otros valores.)
import crypto from 'node:crypto';

export const ALGORITHM = 'SHA1';
export const DIGITS = 6;
export const PERIOD = 30;

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Base32 RFC 4648 sin relleno (formato que esperan las apps autenticadoras). */
export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function currentStep(nowMs = Date.now()) {
  return Math.floor(nowMs / 1000 / PERIOD);
}

/** Código HOTP de un paso concreto. */
export function hotp(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = crypto.createHmac('sha1', secret).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return String(bin).padStart(DIGITS, '0');
}

/**
 * Busca el paso que coincide dentro de la ventana ±1 (tolerancia de reloj de
 * ±30 s). Compara en tiempo constante y sin cortocircuito.
 */
export function matchStep(secret, code, nowMs = Date.now()) {
  const t = currentStep(nowMs);
  let hit = null;
  for (const s of [t - 1, t, t + 1]) {
    const cand = Buffer.from(hotp(secret, s));
    const given = Buffer.from(code);
    if (given.length === cand.length && crypto.timingSafeEqual(given, cand)) hit = s;
  }
  return hit === null ? null : { step: hit, drift: hit - t };
}

/** URI de aprovisionamiento estándar (Key Uri Format) que se codifica en el QR. */
export function provisioningUri({ issuer, account, secretB32 }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: secretB32,
    issuer,
    algorithm: ALGORITHM,
    digits: String(DIGITS),
    period: String(PERIOD),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
