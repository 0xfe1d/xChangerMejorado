import crypto from 'crypto';

// Alfabeto sin caracteres ambiguos (sin 0/O, 1/I/L) — §6.4.
export const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const USER_CODE_LENGTH = 8;

/** Genera un userCode de 8 caracteres sin sesgo de módulo (crypto.randomInt). */
export function generateUserCode(): string {
  let out = '';
  for (let i = 0; i < USER_CODE_LENGTH; i++) {
    out += USER_CODE_ALPHABET[crypto.randomInt(0, USER_CODE_ALPHABET.length)];
  }
  return out;
}

/** "ABCD2345" → "ABCD-2345" para lectura. */
export function formatUserCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * Normaliza la entrada del usuario: sin guion ni espacios, en mayúsculas.
 * Devuelve null si no cumple longitud y alfabeto.
 */
export function normalizeUserCode(input: string): string | null {
  const clean = input.replace(/[\s-]/g, '').toUpperCase();
  if (clean.length !== USER_CODE_LENGTH) return null;
  for (const ch of clean) {
    if (!USER_CODE_ALPHABET.includes(ch)) return null;
  }
  return clean;
}
