import crypto from 'crypto';

// TOTP RFC 6238 con HMAC-SHA-256 (§7.2.3). Lo usa la simulación del mfa-service
// en los tests; el core no implementa TOTP (ADR-23).

export function hotp(key: Buffer, counter: bigint, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(counter);
  const h = crypto.createHmac('sha256', key).update(msg).digest();
  const o = h[h.length - 1] & 0x0f;
  const b = (h.readUInt32BE(o) & 0x7fffffff) % 10 ** digits;
  return b.toString().padStart(digits, '0');
}

export function totp(key: Buffer, unixSeconds: number, opts: { period?: number; t0?: number; digits?: number } = {}): string {
  const step = BigInt(Math.floor((unixSeconds - (opts.t0 ?? 0)) / (opts.period ?? 30)));
  return hotp(key, step, opts.digits ?? 6);
}

export const currentStep = (unixSeconds = Date.now() / 1000, period = 30) => Math.floor(unixSeconds / period);

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
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

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/[\s=]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('base32 inválido');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Código válido "ahora" para un secreto Base32 (lo que mostraría la app). */
export function codeFor(secretBase32: string, at = Date.now() / 1000): string {
  return totp(base32Decode(secretBase32), at);
}
