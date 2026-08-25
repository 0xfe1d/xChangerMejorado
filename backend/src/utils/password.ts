import bcrypt from 'bcrypt';

const BCRYPT_COST = 10;

// Requisitos del SDD: 8+ chars, 1 mayúscula, 1 minúscula, 1 número, 1 símbolo
const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]).{8,}$/;

export function validatePasswordComplexity(password: string): void {
  if (!PASSWORD_REGEX.test(password)) {
    throw new Error(
      'La contraseña debe tener al menos 8 caracteres, una mayúscula, una minúscula, un número y un símbolo.',
    );
  }
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
