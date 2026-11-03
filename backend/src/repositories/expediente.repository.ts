import { prisma } from '../config/prisma';

/** Asignaturas no eliminadas (ni ellas ni sus ancestros) del expediente del usuario. */
export async function listForUser(userId: string) {
  const rows = await prisma.userAsignatura.findMany({
    where: { userId, asignatura: { deletedAt: null, curso: { deletedAt: null, carrera: { deletedAt: null } } } },
    include: {
      asignatura: {
        include: {
          grupos: { where: { deletedAt: null }, orderBy: { nombre: 'asc' } },
          curso: { select: { id: true, nombre: true, carreraId: true, carrera: { select: { nombre: true } } } },
        },
      },
    },
    orderBy: { asignatura: { nombre: 'asc' } },
  });
  return rows.map((r) => r.asignatura);
}

export const countForUser = (userId: string) =>
  prisma.userAsignatura.count({ where: { userId, asignatura: { deletedAt: null } } });

export const findActiveAsignatura = (id: string) =>
  prisma.asignatura.findFirst({ where: { id, deletedAt: null, curso: { deletedAt: null, carrera: { deletedAt: null } } } });

export const findEntry = (userId: string, asignaturaId: string) =>
  prisma.userAsignatura.findUnique({ where: { userId_asignaturaId: { userId, asignaturaId } } });

export const addEntry = (userId: string, asignaturaId: string) =>
  prisma.userAsignatura.create({ data: { userId, asignaturaId } });

export const removeEntry = (userId: string, asignaturaId: string) =>
  prisma.userAsignatura.deleteMany({ where: { userId, asignaturaId } });
