import { Role } from '@prisma/client';
import { prisma } from '../config/prisma';
import { AppError } from '../middleware/errorHandler';
import { logAction } from './log.service';

export interface BlockableUser {
  id: string;
  role: Role;
  blockedUntil: Date | null;
  blockReason: string | null;
}

/**
 * DV-01 / RF-BLQ-05: si el bloqueo temporal ha vencido, la cuenta recupera el
 * rol Estudiante en ese momento (comprobación perezosa en cada autenticación).
 * Devuelve el rol efectivo tras aplicar el vencimiento.
 */
export async function liftExpiredBlock(user: BlockableUser): Promise<Role> {
  if (user.role !== Role.BLOQUEADO || !user.blockedUntil || user.blockedUntil > new Date()) {
    return user.role;
  }
  // Condicional para que dos peticiones concurrentes no lo registren dos veces
  const { count } = await prisma.user.updateMany({
    where: { id: user.id, role: Role.BLOQUEADO, blockedUntil: { lte: new Date() } },
    data: { role: Role.ESTUDIANTE, blockedUntil: null, blockReason: null, blockedById: null },
  });
  if (count > 0) {
    logAction({ userId: user.id, action: 'UNBLOCK_USER', payload: { targetId: user.id, automatic: true } }).catch(console.error);
  }
  return Role.ESTUDIANTE;
}

export function blockDetails(user: BlockableUser) {
  return {
    permanent: user.blockedUntil === null,
    until: user.blockedUntil?.toISOString() ?? null,
    blockedUntil: user.blockedUntil?.toISOString() ?? null, // nombre usado por el frontend actual
    reason: user.blockReason ?? 'Sin motivo especificado',
  };
}

export function accountBlockedError(user: BlockableUser): AppError {
  return new AppError(403, 'Tu cuenta está bloqueada', 'ACCOUNT_BLOCKED', blockDetails(user));
}
