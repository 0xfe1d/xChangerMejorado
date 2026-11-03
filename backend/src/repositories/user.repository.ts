import { Prisma, User, PendingRegistration, Role } from '@prisma/client';
import { prisma } from '../config/prisma';

// Todas las consultas aplican el filtro deletedAt: null para respetar Soft Delete

export async function findUserByEmail(email: string): Promise<User | null> {
  return prisma.user.findFirst({
    where: { email, deletedAt: null },
  });
}

export async function findUserById(id: string): Promise<User | null> {
  return prisma.user.findFirst({
    where: { id, deletedAt: null },
  });
}

export type CreateUserInput = {
  email: string;
  name: string;
  passwordHash: string | null;
  carreraId: string;
  cursoId: string;
  asignaturaIds: string[];
};

/** Crea el usuario definitivo y su matrícula en asignaturas en una sola transacción */
export async function createUser(input: CreateUserInput): Promise<User> {
  return prisma.user.create({
    data: {
      email: input.email,
      name: input.name,
      passwordHash: input.passwordHash,
      role: Role.ESTUDIANTE,
      carreraId: input.carreraId,
      cursoId: input.cursoId,
      enrolledIn: {
        create: input.asignaturaIds.map((asignaturaId) => ({ asignaturaId })),
      },
    },
  });
}

// ── PendingRegistration ───────────────────────────────────────

export async function createPendingRegistration(
  data: Omit<Prisma.PendingRegistrationCreateInput, 'expiresAt'> & { expiresAt: Date },
): Promise<PendingRegistration> {
  // Si ya existía un registro pendiente para ese email/jti, lo reemplazamos
  return prisma.pendingRegistration.upsert({
    where: { email: data.email },
    update: {
      name: data.name,
      passwordHash: data.passwordHash,
      carreraId: data.carreraId,
      cursoId: data.cursoId,
      otpCodeHash: data.otpCodeHash,
      jwtJti: data.jwtJti,
      origin: data.origin,
      externalUserId: data.externalUserId ?? null,
      expiresAt: data.expiresAt,
    },
    create: data,
  });
}

export async function findPendingRegistrationByJti(
  jti: string,
): Promise<PendingRegistration | null> {
  return prisma.pendingRegistration.findUnique({ where: { jwtJti: jti } });
}

export async function deletePendingRegistration(email: string): Promise<void> {
  await prisma.pendingRegistration.delete({ where: { email } });
}

// ── Refresh Token ─────────────────────────────────────────────

/**
 * Actualiza el hash del refresh token almacenado en el usuario.
 * Se usa para implementar rotación de tokens y revocación.
 * El campo se almacena usando un campo genérico de Prisma extendido
 * en un JSON auxiliar; para simplicidad se gestiona en auth.service.
 */
export async function updateRefreshTokenHash(
  userId: string,
  hash: string | null,
): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { refreshTokenHash: hash },
  });
}

export async function updatePasswordHash(userId: string, passwordHash: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash },
  });
}
