import { Role } from '@prisma/client';

import { AppError } from '../middleware/errorHandler';
import { prisma } from '../config/prisma';
import * as adminRepo from '../repositories/admin.repository';
import * as offerRepo from '../repositories/offer.repository';
import { notifyMany } from './notification.service';
import { logAction } from './log.service';
import { publish, notifyEnqueued } from '../events/event-publisher';
import { Prisma } from '@prisma/client';
import { revokeAllChannelSessionsForUser } from './channel-session.service';

type AcademicEntity = 'CARRERA' | 'CURSO' | 'ASIGNATURA' | 'GRUPO';

/** Invalida cachés de clientes (el bot cachea catálogo y grupos, §6.8). */
function academicChanged(entity: AcademicEntity, id: string, action: 'CREATED' | 'DELETED') {
  publish('academic.changed', { entity, id, action }).catch(console.error);
}

/**
 * RF-ACA-06 / RE-05: al confirmar la eliminación de un nodo con referencias,
 * las ofertas OPEN o ACCEPTED bajo él se cancelan (CLOSED) y se anuncia el cambio.
 */
async function cancelOffersUnder(where: Prisma.OfferWhereInput): Promise<number> {
  const offers = await prisma.offer.findMany({
    where: { ...where, deletedAt: null, status: { in: ['OPEN', 'ACCEPTED'] } },
    select: { id: true, status: true, userId: true, acceptedById: true, asignatura: { select: { codigo: true, nombre: true } } },
  });
  if (offers.length === 0) return 0;
  await prisma.$transaction(async (tx) => {
    await tx.offer.updateMany({ where: { id: { in: offers.map((o) => o.id) } }, data: { status: 'CLOSED' } });
    for (const o of offers) {
      await publish(
        'offer.status.changed',
        { offerId: o.id, from: o.status, to: 'CLOSED', actorId: null, reason: 'ENTITY_DELETED', asignatura: o.asignatura },
        { audience: [o.userId, ...(o.acceptedById ? [o.acceptedById] : [])], tx },
      );
    }
  });
  notifyEnqueued();
  return offers.length;
}

// ─────────────────────────────────────────────────────────────
// CARRERAS
// ─────────────────────────────────────────────────────────────

export async function createCarrera(nombre: string, requesterId: string) {
  const existing = await prisma.carrera.findFirst({ where: { nombre, deletedAt: null } });
  if (existing) throw new AppError(409, 'Ya existe una carrera con ese nombre');

  const carrera = await adminRepo.createCarrera(nombre);

  // Auto-asignar ámbito a todos los PROPIETARIOS
  const propietarios = await prisma.user.findMany({
    where: { role: Role.PROPIETARIO, deletedAt: null },
    select: { id: true },
  });
  await Promise.all(propietarios.map((p) => adminRepo.addAdminScope(p.id, carrera.id)));

  logAction({ userId: requesterId, action: 'CREATE_CARRERA', payload: { carreraId: carrera.id, nombre } }).catch(console.error);
  academicChanged('CARRERA', carrera.id, 'CREATED');
  return carrera;
}

export async function deleteCarrera(carreraId: string, requesterId: string) {
  const carrera = await adminRepo.findCareerById(carreraId);
  if (!carrera) throw new AppError(404, 'Carrera no encontrada');

  const activeOffers = await prisma.offer.count({
    where: { deletedAt: null, status: { in: ['OPEN', 'ACCEPTED'] }, asignatura: { curso: { carreraId } } },
  });

  // El controlador puede devolver esta info para mostrar el modal de confirmación
  const hasReferences = activeOffers > 0;

  await adminRepo.softDeleteCarrera(carreraId);
  academicChanged('CARRERA', carreraId, 'DELETED');

  let affected = 0;
  let cancelledOffers = 0;
  if (hasReferences) {
    cancelledOffers = await cancelOffersUnder({ asignatura: { curso: { carreraId } } });
    affected = await _notifyAffectedUsersByCarrera(carreraId, `La carrera "${carrera.nombre}" ha sido eliminada del sistema. Las ofertas asociadas han sido canceladas.`);
  }

  logAction({ userId: requesterId, action: 'DELETE_CARRERA', payload: { carreraId, cancelledOffers } }).catch(console.error);
  return { carrera, hasReferences, affectedUsers: affected };
}

export async function listCareers() {
  return adminRepo.findAllCareers();
}

// ─────────────────────────────────────────────────────────────
// CURSOS
// ─────────────────────────────────────────────────────────────

export async function createCurso(carreraId: string, nombre: string, requesterId: string) {
  const carrera = await adminRepo.findCareerById(carreraId);
  if (!carrera) throw new AppError(404, 'Carrera no encontrada');

  const existing = await prisma.curso.findFirst({ where: { carreraId, nombre, deletedAt: null } });
  if (existing) throw new AppError(409, 'Ya existe un curso con ese nombre en esta carrera');

  const curso = await adminRepo.createCurso(carreraId, nombre);
  logAction({ userId: requesterId, action: 'CREATE_CURSO', payload: { cursoId: curso.id, nombre, carreraId } }).catch(console.error);
  academicChanged('CURSO', curso.id, 'CREATED');
  return curso;
}

export async function deleteCurso(cursoId: string, requesterId: string) {
  const curso = await adminRepo.findCursoById(cursoId);
  if (!curso) throw new AppError(404, 'Curso no encontrado');

  const activeOffers = await adminRepo.countActiveOffersByCurso(cursoId);
  const hasReferences = activeOffers > 0;

  // Se notifica antes de ocultar para poder localizar a los afectados por las ofertas
  let affectedCount = 0;
  let cancelledOffers = 0;
  if (hasReferences) {
    affectedCount = await _notifyAffectedUsersByCurso(
      cursoId,
      `El curso "${curso.nombre}" ha sido eliminado. Las ofertas asociadas han sido canceladas.`,
    );
  }

  if (hasReferences) cancelledOffers = await cancelOffersUnder({ asignatura: { cursoId } });
  await adminRepo.softDeleteCurso(cursoId);
  academicChanged('CURSO', cursoId, 'DELETED');

  logAction({ userId: requesterId, action: 'DELETE_CURSO', payload: { cursoId, cancelledOffers } }).catch(console.error);
  return { curso, hasReferences, affectedUsers: affectedCount };
}

export async function listCursos(carreraId: string) {
  return adminRepo.findCursosByCarrera(carreraId);
}

// ─────────────────────────────────────────────────────────────
// ASIGNATURAS
// ─────────────────────────────────────────────────────────────

export async function createAsignatura(
  cursoId: string,
  nombre: string,
  codigo: string,
  requesterId: string,
) {
  const curso = await adminRepo.findCursoById(cursoId);
  if (!curso) throw new AppError(404, 'Curso no encontrado');

  const existing = await prisma.asignatura.findFirst({ where: { codigo, deletedAt: null } });
  if (existing) throw new AppError(409, 'Ya existe una asignatura con ese código');

  const asignatura = await adminRepo.createAsignatura(cursoId, nombre, codigo);
  logAction({ userId: requesterId, action: 'CREATE_ASIGNATURA', payload: { asignaturaId: asignatura.id, nombre, codigo, cursoId } }).catch(console.error);
  academicChanged('ASIGNATURA', asignatura.id, 'CREATED');
  return asignatura;
}

export async function deleteAsignatura(asignaturaId: string, requesterId: string) {
  const asignatura = await adminRepo.findAsignaturaById(asignaturaId);
  if (!asignatura) throw new AppError(404, 'Asignatura no encontrada');

  const activeOffers = await adminRepo.countActiveOffersByAsignatura(asignaturaId);
  const hasReferences = activeOffers > 0;

  // Se notifica antes de ocultar para poder localizar a los afectados por las ofertas
  let affectedCount = 0;
  let cancelledOffers = 0;
  if (hasReferences) {
    affectedCount = await _notifyAffectedUsersByAsignatura(
      asignaturaId,
      `La asignatura "${asignatura.nombre}" ha sido eliminada. Las ofertas asociadas han sido canceladas.`,
    );
  }

  if (hasReferences) cancelledOffers = await cancelOffersUnder({ asignaturaId });
  await adminRepo.softDeleteAsignatura(asignaturaId);
  academicChanged('ASIGNATURA', asignaturaId, 'DELETED');

  logAction({ userId: requesterId, action: 'DELETE_ASIGNATURA', payload: { asignaturaId, cancelledOffers } }).catch(console.error);
  return { asignatura, hasReferences, affectedUsers: affectedCount };
}

export async function listAsignaturas(cursoId: string) {
  return adminRepo.findAsignaturasByCurso(cursoId);
}

// ─────────────────────────────────────────────────────────────
// GRUPOS
// ─────────────────────────────────────────────────────────────

export async function createGrupo(asignaturaId: string, nombre: string, requesterId: string) {
  const asignatura = await adminRepo.findAsignaturaById(asignaturaId);
  if (!asignatura) throw new AppError(404, 'Asignatura no encontrada');

  const existing = await prisma.grupo.findFirst({ where: { asignaturaId, nombre, deletedAt: null } });
  if (existing) throw new AppError(409, 'Ya existe un grupo con ese nombre en esta asignatura');

  const grupo = await adminRepo.createGrupo(asignaturaId, nombre);
  logAction({ userId: requesterId, action: 'CREATE_GRUPO', payload: { grupoId: grupo.id, nombre, asignaturaId } }).catch(console.error);
  academicChanged('GRUPO', grupo.id, 'CREATED');
  return grupo;
}

export async function deleteGrupo(grupoId: string, requesterId: string) {
  const grupo = await adminRepo.findGrupoById(grupoId);
  if (!grupo) throw new AppError(404, 'Grupo no encontrado');

  const activeOffers = await adminRepo.countActiveOffersByGrupo(grupoId);
  const hasReferences = activeOffers > 0;

  // Se notifica antes de ocultar para poder localizar a los afectados por las ofertas
  let affectedCount = 0;
  let cancelledOffers = 0;
  if (hasReferences) {
    affectedCount = await _notifyAffectedUsersByGrupo(
      grupoId,
      `El grupo "${grupo.nombre}" ha sido eliminado. Las ofertas asociadas han sido canceladas.`,
    );
  }

  if (hasReferences) cancelledOffers = await cancelOffersUnder({ OR: [{ grupoActualId: grupoId }, { grupoDeseadoId: grupoId }] });
  await adminRepo.softDeleteGrupo(grupoId);
  academicChanged('GRUPO', grupoId, 'DELETED');

  logAction({ userId: requesterId, action: 'DELETE_GRUPO', payload: { grupoId, cancelledOffers } }).catch(console.error);
  return { grupo, hasReferences, affectedUsers: affectedCount };
}

export async function listGrupos(asignaturaId: string) {
  return adminRepo.findGruposByAsignatura(asignaturaId);
}

// ─────────────────────────────────────────────────────────────
// BLOQUEO / DESBLOQUEO DE USUARIOS
// ─────────────────────────────────────────────────────────────

export async function blockUser(
  targetId: string,
  reason: string,
  blockedUntil: Date | null,
  requesterId: string,
  requesterRole: Role,
) {
  const target = await adminRepo.findUserByIdFull(targetId);
  if (!target) throw new AppError(404, 'Usuario no encontrado');

  // DV-02 / RF-BLQ-02: nadie se bloquea a sí mismo ni a un Propietario
  if (targetId === requesterId) throw new AppError(403, 'No puedes bloquearte a ti mismo');
  if (target.role === Role.PROPIETARIO) throw new AppError(403, 'No se puede bloquear a un Propietario');
  // Un Embajador solo bloquea Estudiantes de su ámbito (AR-05)
  if (requesterRole === Role.EMBAJADOR && target.role !== Role.ESTUDIANTE) {
    throw new AppError(403, 'Un embajador solo puede bloquear estudiantes');
  }
  await assertUserInScope(targetId, requesterId, requesterRole);
  if (blockedUntil && blockedUntil <= new Date()) throw new AppError(400, 'La fecha de fin del bloqueo debe ser futura');

  // Orden de Arquitectura §10.2: primero se revoca la capacidad de actuar
  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: targetId },
      data: { role: Role.BLOQUEADO, blockedUntil, blockReason: reason, blockedById: requesterId, refreshTokenHash: null },
    });
    await offerRepo.deactivateUserOffers(targetId, tx);
    await publish(
      'account.blocked',
      { userId: targetId, permanent: blockedUntil === null, until: blockedUntil?.toISOString() ?? null, reason },
      { audience: [targetId], tx },
    );
  });
  notifyEnqueued();
  // RF-TGB-10: las sesiones de canal también se revocan
  await revokeAllChannelSessionsForUser(targetId, 'BLOCKED');

  logAction({
    userId: requesterId,
    action: 'BLOCK_USER',
    payload: { targetId, reason, blockedUntil },
  }).catch(console.error);
}

export async function unblockUser(targetId: string, requesterId: string) {
  const target = await adminRepo.findUserByIdFull(targetId);
  if (!target) throw new AppError(404, 'Usuario no encontrado');
  if (target.role !== Role.BLOQUEADO) throw new AppError(409, 'El usuario no está bloqueado');

  await prisma.user.update({
    where: { id: targetId },
    data: {
      role: Role.ESTUDIANTE,
      blockedUntil: null,
      blockReason: null,
      blockedById: null,
    },
  });

  publish('account.unblocked', { userId: targetId }, { audience: [targetId] }).catch(console.error);
  logAction({ userId: requesterId, action: 'UNBLOCK_USER', payload: { targetId } }).catch(console.error);
}

// ─────────────────────────────────────────────────────────────
// GESTIÓN DE EMBAJADORES
// ─────────────────────────────────────────────────────────────

export async function promoteToEmbajador(
  targetId: string,
  scopes: Array<{ carreraId: string; cursoId?: string }>,
  requesterId: string,
) {
  const target = await adminRepo.findUserByIdFull(targetId);
  if (!target) throw new AppError(404, 'Usuario no encontrado');
  if (target.role === Role.PROPIETARIO) throw new AppError(400, 'No se puede modificar el rol de un Propietario');

  await prisma.user.update({ where: { id: targetId }, data: { role: Role.EMBAJADOR } });
  await adminRepo.clearAdminScopes(targetId);
  await Promise.all(scopes.map((s) => adminRepo.addAdminScope(targetId, s.carreraId, s.cursoId)));

  logAction({ userId: requesterId, action: 'PROMOTE_EMBAJADOR', payload: { targetId, scopes } }).catch(console.error);
}

export async function demoteEmbajador(targetId: string, requesterId: string) {
  const target = await adminRepo.findUserByIdFull(targetId);
  if (!target) throw new AppError(404, 'Usuario no encontrado');
  if (target.role !== Role.EMBAJADOR) throw new AppError(400, 'El usuario no es embajador');

  await prisma.user.update({ where: { id: targetId }, data: { role: Role.ESTUDIANTE } });
  await adminRepo.clearAdminScopes(targetId);

  logAction({ userId: requesterId, action: 'DEMOTE_EMBAJADOR', payload: { targetId } }).catch(console.error);
}

export async function updateAdminScope(
  targetId: string,
  scopes: Array<{ carreraId: string; cursoId?: string }>,
  requesterId: string,
) {
  const target = await adminRepo.findUserByIdFull(targetId);
  if (!target) throw new AppError(404, 'Usuario no encontrado');
  if (target.role !== Role.EMBAJADOR) throw new AppError(400, 'Solo se puede modificar el ámbito de un embajador');

  await adminRepo.clearAdminScopes(targetId);
  await Promise.all(scopes.map((s) => adminRepo.addAdminScope(targetId, s.carreraId, s.cursoId)));

  logAction({ userId: requesterId, action: 'UPDATE_SCOPE', payload: { targetId, scopes } }).catch(console.error);
}

// ─────────────────────────────────────────────────────────────
// AUDITORÍA DE USUARIOS
// ─────────────────────────────────────────────────────────────

/**
 * Verifica que el usuario objetivo está dentro del ámbito del admin.
 * PROPIETARIO tiene acceso irrestricto.
 */
export async function assertUserInScope(
  targetId: string,
  requesterId: string,
  requesterRole: Role,
): Promise<void> {
  if (requesterRole === Role.PROPIETARIO) return;

  const target = await prisma.user.findFirst({
    where: { id: targetId, deletedAt: null },
    select: { carreraId: true, cursoId: true },
  });
  if (!target) throw new AppError(404, 'Usuario no encontrado');

  const scopes = await prisma.adminScope.findMany({ where: { userId: requesterId } });
  const inScope = scopes.some(
    (s) =>
      s.carreraId === target.carreraId &&
      (s.cursoId === null || s.cursoId === target.cursoId),
  );
  if (!inScope) throw new AppError(403, 'No tienes ámbito de administración sobre este usuario');
}

export async function searchUsersInScope(
  query: string,
  requesterId: string,
  requesterRole: Role,
) {
  const q = query.trim();
  if (!q) throw new AppError(400, 'Se requiere un término de búsqueda');

  let carreraIds: string[] | undefined;
  let cursoIds: string[] | undefined;

  if (requesterRole !== Role.PROPIETARIO) {
    const scopes = await prisma.adminScope.findMany({ where: { userId: requesterId } });
    carreraIds = scopes.map((s) => s.carreraId);
    cursoIds = scopes.flatMap((s) => (s.cursoId ? [s.cursoId] : []));
  }

  return prisma.user.findMany({
    where: {
      deletedAt: null,
      AND: [
        {
          OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { email: { contains: q, mode: 'insensitive' } },
          ],
        },
        ...(carreraIds
          ? [{ OR: [{ carreraId: { in: carreraIds } }, ...(cursoIds?.length ? [{ cursoId: { in: cursoIds } }] : [])] }]
          : []),
      ],
    },
    select: { id: true, name: true, email: true, role: true },
    take: 20,
  });
}

export async function getUserDetails(
  targetId: string,
  requesterId: string,
  requesterRole: Role,
) {
  await assertUserInScope(targetId, requesterId, requesterRole);

  const [user, logs, loginHistory] = await Promise.all([
    prisma.user.findFirst({
      where: { id: targetId, deletedAt: null },
      select: {
        id: true, name: true, email: true, role: true,
        blockReason: true, blockedUntil: true, createdAt: true,
        carrera: { select: { nombre: true } },
        curso: { select: { nombre: true } },
      },
    }),
    prisma.log.findMany({
      where: { userId: targetId },
      orderBy: { timestamp: 'desc' },
      take: 50,
    }),
    prisma.loginHistory.findMany({
      where: { userId: targetId },
      orderBy: { timestamp: 'desc' },
      take: 20,
    }),
  ]);

  if (!user) throw new AppError(404, 'Usuario no encontrado');
  return { user, logs, loginHistory };
}

export async function adminForcePasswordChange(
  targetId: string,
  newPassword: string,
  requesterId: string,
  requesterRole: Role,
) {
  await assertUserInScope(targetId, requesterId, requesterRole);

  const { validatePasswordComplexity, hashPassword } = await import('../utils/password');
  validatePasswordComplexity(newPassword);
  const newHash = await hashPassword(newPassword);

  await prisma.user.update({ where: { id: targetId }, data: { passwordHash: newHash, refreshTokenHash: null } });
  logAction({ userId: requesterId, action: 'ADMIN_FORCE_PASSWORD', payload: { targetId } }).catch(console.error);
}

export { adminRepo as repository };

// ─────────────────────────────────────────────────────────────
// Helpers privados de notificación en cascada
// ─────────────────────────────────────────────────────────────

async function _notifyAffectedUsersByCarrera(carreraId: string, message: string): Promise<number> {
  const rows = await prisma.user.findMany({
    where: { carreraId, deletedAt: null },
    select: { id: true, email: true },
  });
  if (rows.length === 0) return 0;
  const recipients = rows.map((u) => ({ userId: u.id, email: u.email }));
  await notifyMany(recipients, 'Aviso del sistema', message, { kind: 'ENTITY_DELETED' });
  return rows.length;
}

async function _notifyAffectedUsersByCurso(cursoId: string, message: string): Promise<number> {
  const rows = await prisma.user.findMany({
    where: { cursoId, deletedAt: null },
    select: { id: true, email: true },
  });
  if (rows.length === 0) return 0;
  const recipients = rows.map((u) => ({ userId: u.id, email: u.email }));
  await notifyMany(recipients, 'Aviso del sistema', message, { kind: 'ENTITY_DELETED' });
  return rows.length;
}

async function _notifyAffectedUsersByAsignatura(asignaturaId: string, message: string): Promise<number> {
  const enrolled = await prisma.userAsignatura.findMany({
    where: { asignaturaId },
    include: { user: { select: { id: true, email: true, deletedAt: true } } },
  });
  const rows = enrolled.filter((e) => !e.user.deletedAt).map((e) => e.user);
  if (rows.length === 0) return 0;
  const recipients = rows.map((u) => ({ userId: u.id, email: u.email }));
  await notifyMany(recipients, 'Aviso del sistema', message, { kind: 'ENTITY_DELETED' });
  return rows.length;
}

async function _notifyAffectedUsersByGrupo(grupoId: string, message: string): Promise<number> {
  const offers = await prisma.offer.findMany({
    where: {
      deletedAt: null,
      status: { in: ['OPEN', 'ACCEPTED'] },
      OR: [{ grupoDeseadoId: grupoId }, { grupoActualId: grupoId }],
    },
    include: {
      user: { select: { id: true, email: true } },
      acceptedBy: { select: { id: true, email: true } },
    },
  });

  const uniqueUsers = new Map<string, { id: string; email: string }>();
  for (const o of offers) {
    if (o.user) uniqueUsers.set(o.user.id, o.user);
    if (o.acceptedBy) uniqueUsers.set(o.acceptedBy.id, o.acceptedBy);
  }

  const rows = [...uniqueUsers.values()];
  if (rows.length === 0) return 0;
  const recipients = rows.map((u) => ({ userId: u.id, email: u.email }));
  await notifyMany(recipients, 'Aviso del sistema', message, { kind: 'ENTITY_DELETED' });
  return rows.length;
}

// ─────────────────────────────────────────────────────────────
// Lecturas no administrativas del catálogo (AR-03, EP-C-14)
// ─────────────────────────────────────────────────────────────

const ACTIVE_ASIGNATURA = { deletedAt: null, curso: { deletedAt: null, carrera: { deletedAt: null } } } as const;

/** EP-C-14: grupos de una asignatura sin pasar por /admin (RF-ACA-07). */
export async function listGroupsForSubject(asignaturaId: string) {
  const asignatura = await prisma.asignatura.findFirst({ where: { id: asignaturaId, ...ACTIVE_ASIGNATURA }, select: { id: true } });
  if (!asignatura) throw new AppError(404, 'Asignatura no encontrada', 'NOT_FOUND');
  return prisma.grupo.findMany({
    where: { asignaturaId, deletedAt: null },
    select: { id: true, nombre: true },
    orderBy: { nombre: 'asc' },
  });
}

/** Búsqueda pública de asignaturas (catálogo de registro y expediente). */
export async function searchSubjectsPublic(
  q: string,
  opts?: { carreraId?: string; cursoId?: string; limit?: number; offset?: number },
) {
  const where = {
    ...ACTIVE_ASIGNATURA,
    ...(opts?.cursoId ? { cursoId: opts.cursoId } : {}),
    ...(opts?.carreraId
      ? { curso: { carreraId: opts.carreraId, deletedAt: null, carrera: { deletedAt: null } } }
      : {}),
    ...(q
      ? { OR: [{ nombre: { contains: q, mode: 'insensitive' as const } }, { codigo: { contains: q, mode: 'insensitive' as const } }] }
      : {}),
  };

  if (opts?.limit !== undefined || opts?.offset !== undefined) {
    const limit = opts.limit ?? 10;
    const offset = opts.offset ?? 0;
    const [rows, total] = await Promise.all([
      prisma.asignatura.findMany({
        where,
        select: { id: true, codigo: true, nombre: true, cursoId: true },
        orderBy: { nombre: 'asc' },
        take: limit,
        skip: offset,
      }),
      prisma.asignatura.count({ where }),
    ]);
    return { items: rows, total };
  }

  return prisma.asignatura.findMany({
    where,
    include: {
      grupos: { where: { deletedAt: null }, orderBy: { nombre: 'asc' } },
      curso: { select: { id: true, nombre: true, carreraId: true, carrera: { select: { nombre: true } } } },
    },
    orderBy: { nombre: 'asc' },
    take: 20,
  });
}
