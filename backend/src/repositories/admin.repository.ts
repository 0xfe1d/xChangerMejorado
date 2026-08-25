import { prisma } from '../config/prisma';

// ── Carreras ──────────────────────────────────────────────────

export async function findAllCareers() {
  return prisma.carrera.findMany({
    where: { deletedAt: null },
    orderBy: { nombre: 'asc' },
  });
}

export async function findCareerById(id: string) {
  return prisma.carrera.findFirst({ where: { id, deletedAt: null } });
}

export async function createCarrera(nombre: string) {
  return prisma.carrera.create({ data: { nombre } });
}

export async function softDeleteCarrera(id: string) {
  return prisma.carrera.update({
    where: { id },
    data: { deletedAt: new Date() },
  });
}

// ── Cursos ────────────────────────────────────────────────────

export async function findCursosByCarrera(carreraId: string) {
  return prisma.curso.findMany({
    where: { carreraId, deletedAt: null },
    orderBy: { nombre: 'asc' },
  });
}

export async function findCursoById(id: string) {
  return prisma.curso.findFirst({ where: { id, deletedAt: null } });
}

export async function createCurso(carreraId: string, nombre: string) {
  return prisma.curso.create({ data: { carreraId, nombre } });
}

export async function softDeleteCurso(id: string) {
  return prisma.curso.update({
    where: { id },
    data: { deletedAt: new Date() },
  });
}

// ── Asignaturas ───────────────────────────────────────────────

export async function findAsignaturasByCurso(cursoId: string) {
  return prisma.asignatura.findMany({
    where: { cursoId, deletedAt: null },
    orderBy: { nombre: 'asc' },
    include: { grupos: { where: { deletedAt: null } } },
  });
}

export async function findAsignaturaById(id: string) {
  return prisma.asignatura.findFirst({ where: { id, deletedAt: null } });
}

export async function createAsignatura(cursoId: string, nombre: string, codigo: string) {
  return prisma.asignatura.create({ data: { cursoId, nombre, codigo } });
}

export async function softDeleteAsignatura(id: string) {
  return prisma.asignatura.update({
    where: { id },
    data: { deletedAt: new Date() },
  });
}

// ── Grupos ────────────────────────────────────────────────────

export async function findGruposByAsignatura(asignaturaId: string) {
  return prisma.grupo.findMany({
    where: { asignaturaId, deletedAt: null },
    orderBy: { nombre: 'asc' },
  });
}

export async function findGrupoById(id: string) {
  return prisma.grupo.findFirst({ where: { id, deletedAt: null } });
}

export async function createGrupo(asignaturaId: string, nombre: string) {
  return prisma.grupo.create({ data: { asignaturaId, nombre } });
}

export async function softDeleteGrupo(id: string) {
  return prisma.grupo.update({
    where: { id },
    data: { deletedAt: new Date() },
  });
}

// ── Comprobación de referencias ───────────────────────────────

/** Comprueba si hay ofertas activas vinculadas a un curso dado */
export async function countActiveOffersByCurso(cursoId: string): Promise<number> {
  return prisma.offer.count({
    where: {
      deletedAt: null,
      status: { in: ['OPEN', 'ACCEPTED'] },
      asignatura: { cursoId, deletedAt: null },
    },
  });
}

export async function countActiveOffersByAsignatura(asignaturaId: string): Promise<number> {
  return prisma.offer.count({
    where: { asignaturaId, deletedAt: null, status: { in: ['OPEN', 'ACCEPTED'] } },
  });
}

export async function countActiveOffersByGrupo(grupoId: string): Promise<number> {
  return prisma.offer.count({
    where: {
      deletedAt: null,
      status: { in: ['OPEN', 'ACCEPTED'] },
      OR: [{ grupoDeseadoId: grupoId }, { grupoActualId: grupoId }],
    },
  });
}

// ── Usuarios (bloqueo / embajadores) ─────────────────────────

export async function findUserByIdFull(id: string) {
  return prisma.user.findFirst({
    where: { id, deletedAt: null },
    include: { adminScopes: true },
  });
}

export async function findEmbajadores() {
  return prisma.user.findMany({
    where: { role: 'EMBAJADOR', deletedAt: null },
    select: { id: true, name: true, email: true, adminScopes: true },
  });
}

export async function searchUsers(query: string) {
  return prisma.user.findMany({
    where: {
      deletedAt: null,
      OR: [
        { name: { contains: query, mode: 'insensitive' } },
        { email: { contains: query, mode: 'insensitive' } },
      ],
    },
    select: { id: true, name: true, email: true, role: true },
    take: 20,
  });
}

// ── AdminScope ────────────────────────────────────────────────

export async function addAdminScope(userId: string, carreraId: string, cursoId?: string) {
  // Prisma compound unique con nullable: buscamos manualmente para evitar el problema de null en where
  const existing = await prisma.adminScope.findFirst({ where: { userId, carreraId, cursoId: cursoId ?? null } });
  if (existing) return existing;
  return prisma.adminScope.create({ data: { userId, carreraId, cursoId: cursoId ?? null } });
}

export async function removeAdminScope(userId: string, carreraId: string, cursoId?: string) {
  return prisma.adminScope.deleteMany({
    where: { userId, carreraId, cursoId: cursoId ?? null },
  });
}

export async function clearAdminScopes(userId: string) {
  return prisma.adminScope.deleteMany({ where: { userId } });
}
