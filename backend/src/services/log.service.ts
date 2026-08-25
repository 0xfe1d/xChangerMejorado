import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';

export interface LogInput {
  userId: string;
  action: string;
  payload: Prisma.InputJsonValue;
}

/**
 * Registra una acción en el log inmutable del sistema.
 * Los logs nunca se borran ni se actualizan.
 * Se llama de forma no bloqueante desde los servicios para no impactar latencia.
 */
export async function logAction(input: LogInput): Promise<void> {
  await prisma.log.create({
    data: {
      userId: input.userId,
      action: input.action,
      payload: input.payload,
    },
  });
}

export interface LogQueryOptions {
  carreraIds: string[];
  cursoIds?: string[];
  actionFilter?: string;
  /** Búsqueda por nombre o email del usuario que realizó la acción */
  userFilter?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  pageSize?: number;
}

export async function getLogs(options: LogQueryOptions) {
  const { carreraIds, cursoIds, actionFilter, userFilter, dateFrom, dateTo, page = 1, pageSize = 50 } = options;

  const usersInScope = await prisma.user.findMany({
    where: {
      deletedAt: null,
      OR: [
        { carreraId: { in: carreraIds } },
        ...(cursoIds && cursoIds.length > 0 ? [{ cursoId: { in: cursoIds } }] : []),
      ],
      ...(userFilter
        ? {
            AND: {
              OR: [
                { name: { contains: userFilter, mode: 'insensitive' } },
                { email: { contains: userFilter, mode: 'insensitive' } },
              ],
            },
          }
        : {}),
    },
    select: { id: true },
  });

  const userIds = usersInScope.map((u) => u.id);

  const where: Prisma.LogWhereInput = {
    userId: { in: userIds },
    ...(actionFilter ? { action: { contains: actionFilter, mode: 'insensitive' } } : {}),
    ...(dateFrom || dateTo
      ? {
          timestamp: {
            ...(dateFrom ? { gte: new Date(dateFrom) } : {}),
            ...(dateTo ? { lte: new Date(new Date(dateTo).setHours(23, 59, 59, 999)) } : {}),
          },
        }
      : {}),
  };

  const [total, logs] = await Promise.all([
    prisma.log.count({ where }),
    prisma.log.findMany({
      where,
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: { timestamp: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  return { logs, total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
}

/** Logs paginados de un único usuario (para la vista de auditoría de usuario). */
export async function getUserLogsPaginated(userId: string, page = 1, pageSize = 25, actionFilter?: string, dateFrom?: string, dateTo?: string) {
  const where: Prisma.LogWhereInput = {
    userId,
    ...(actionFilter ? { action: { contains: actionFilter, mode: 'insensitive' } } : {}),
    ...(dateFrom || dateTo
      ? {
          timestamp: {
            ...(dateFrom ? { gte: new Date(dateFrom) } : {}),
            ...(dateTo ? { lte: new Date(new Date(dateTo).setHours(23, 59, 59, 999)) } : {}),
          },
        }
      : {}),
  };

  const [total, logs] = await Promise.all([
    prisma.log.count({ where }),
    prisma.log.findMany({
      where,
      orderBy: { timestamp: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  return { logs, total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
}
