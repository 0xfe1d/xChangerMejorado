import bcrypt from 'bcrypt';

const BCRYPT_COST = 10;

// Requisitos del SDD: 8+ chars, 1 mayúscula, 1 minúscula, 1 número, 1 símbolo
const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]).{8,}$/;

// Hash bcrypt válido de una cadena aleatoria: se compara contra él cuando el
// usuario no existe o no tiene contraseña, para igualar tiempos (RF-AUT-09).
let dummyHash: string | null = null;
const getDummyHash = () => (dummyHash ??= bcrypt.hashSync(`dummy-${Math.random()}`, BCRYPT_COST));

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

export async function verifyPassword(plain: string, hash: string | null | undefined): Promise<boolean> {
  if (!hash) {
    await bcrypt.compare(plain, getDummyHash());
    return false;
  }
  return bcrypt.compare(plain, hash);
}
