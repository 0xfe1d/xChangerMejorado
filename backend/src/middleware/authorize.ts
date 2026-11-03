import { Request, Response, NextFunction } from 'express';
import { Role } from '@prisma/client';
import { prisma } from '../config/prisma';
import { AppError } from './errorHandler';

// Helpers para resolver carreraId desde recursos anidados
async function carreraIdFromCurso(cursoId: string): Promise<string | null> {
  const curso = await prisma.curso.findFirst({ where: { id: cursoId }, select: { carreraId: true } });
  return curso?.carreraId ?? null;
}

type Location = { carreraId: string; cursoId: string };

async function locationFromAsignatura(asignaturaId: string): Promise<Location | null> {
  const asig = await prisma.asignatura.findFirst({
    where: { id: asignaturaId },
    select: { cursoId: true, curso: { select: { carreraId: true } } },
  });
  return asig ? { carreraId: asig.curso.carreraId, cursoId: asig.cursoId } : null;
}

async function locationFromGrupo(grupoId: string): Promise<Location | null> {
  const grupo = await prisma.grupo.findFirst({
    where: { id: grupoId },
    select: { asignatura: { select: { cursoId: true, curso: { select: { carreraId: true } } } } },
  });
  return grupo ? { carreraId: grupo.asignatura.curso.carreraId, cursoId: grupo.asignatura.cursoId } : null;
}

/**
 * Regla de cobertura (Arquitectura §6.2, corrige AR-05): un ámbito con curso
 * nulo cubre toda la carrera; uno con curso concreto cubre solo ese curso.
 */
export async function scopeCovers(userId: string, loc: Location): Promise<boolean> {
  const scope = await prisma.adminScope.findFirst({
    where: { userId, carreraId: loc.carreraId, OR: [{ cursoId: null }, { cursoId: loc.cursoId }] },
  });
  return scope !== null;
}

/**
 * Verifica que el usuario autenticado tiene al menos uno de los roles indicados.
 * Debe usarse DESPUÉS de `authenticate`.
 */
export function requireRole(...roles: Role[]) {
  return (_req: Request, _res: Response, next: NextFunction): void => {
    const user = _req.user;
    if (!user) {
      return next(new AppError(401, 'Autenticación requerida'));
    }
    if (!roles.includes(user.role)) {
      return next(new AppError(403, 'No tienes permisos para esta acción'));
    }
    next();
  };
}

/**
 * Verifica que el usuario tiene ámbito de administración sobre la
 * carrera (y opcionalmente el curso) extraídos de los params/query de la request.
 *
 * Lógica del SDD:
 *   · PROPIETARIO → ámbito total, siempre pasa.
 *   · EMBAJADOR → debe tener un AdminScope que cubra (carreraId, cursoId):
 *       - AdminScope con cursoId = null → cubre toda la carrera.
 *       - AdminScope con cursoId = X   → cubre solo ese curso.
 *
 * Los params se leen en este orden de prioridad: req.params → req.body → req.query.
 */
export function requireScope(options: { carreraParam?: string; cursoParam?: string } = {}) {
  const carreraKey = options.carreraParam ?? 'carreraId';
  const cursoKey = options.cursoParam ?? 'cursoId';

  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const user = req.user;
    if (!user) {
      return next(new AppError(401, 'Autenticación requerida'));
    }

    // PROPIETARIO tiene ámbito total
    if (user.role === Role.PROPIETARIO) {
      return next();
    }

    if (user.role !== Role.EMBAJADOR) {
      return next(new AppError(403, 'Solo los administradores pueden acceder a este recurso'));
    }

    const carreraId =
      (req.params[carreraKey] ?? req.body[carreraKey] ?? req.query[carreraKey]) as string | undefined;

    const cursoId =
      (req.params[cursoKey] ?? req.body[cursoKey] ?? req.query[cursoKey]) as string | undefined;

    if (!carreraId) {
      return next(new AppError(400, `Se requiere el parámetro ${carreraKey}`));
    }

    // Buscar un scope que cubra la carrera y, si se proporcionó, el curso
    const scope = await prisma.adminScope.findFirst({
      where: {
        userId: user.sub,
        carreraId,
        OR: [
          { cursoId: null },                        // ámbito de carrera completa
          ...(cursoId ? [{ cursoId }] : []),         // ámbito de curso específico
        ],
      },
    });

    if (!scope) {
      return next(new AppError(403, 'No tienes ámbito de administración sobre este recurso'));
    }

    next();
  };
}
/**
 * Verifica ámbito resolviendo carreraId a partir de un cursoId (params/body/query).
 */
export function requireScopeViaCurso(key = 'cursoId') {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const user = req.user;
    if (!user) return next(new AppError(401, 'Autenticación requerida'));
    if (user.role === Role.PROPIETARIO) return next();
    if (user.role !== Role.EMBAJADOR) return next(new AppError(403, 'Solo los administradores pueden acceder'));

    const cursoId = (req.params[key] ?? req.body[key] ?? req.query[key]) as string | undefined;
    if (!cursoId) return next(new AppError(400, `Se requiere ${key}`));

    const carreraId = await carreraIdFromCurso(cursoId);
    if (!carreraId) return next(new AppError(404, 'Curso no encontrado'));

    const scope = await prisma.adminScope.findFirst({
      where: { userId: user.sub, carreraId, OR: [{ cursoId: null }, { cursoId }] },
    });
    if (!scope) return next(new AppError(403, 'No tienes ámbito de administración sobre este recurso'));
    next();
  };
}

/**
 * Verifica ámbito resolviendo carreraId a partir de un asignaturaId (params/body/query).
 */
export function requireScopeViaAsignatura(key = 'asignaturaId') {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const user = req.user;
    if (!user) return next(new AppError(401, 'Autenticación requerida'));
    if (user.role === Role.PROPIETARIO) return next();
    if (user.role !== Role.EMBAJADOR) return next(new AppError(403, 'Solo los administradores pueden acceder'));

    const asignaturaId = (req.params[key] ?? req.body[key] ?? req.query[key]) as string | undefined;
    if (!asignaturaId) return next(new AppError(400, `Se requiere ${key}`));

    const loc = await locationFromAsignatura(asignaturaId);
    if (!loc) return next(new AppError(404, 'Asignatura no encontrada'));
    if (!(await scopeCovers(user.sub, loc))) return next(new AppError(403, 'No tienes ámbito de administración sobre este recurso'));
    next();
  };
}

/**
 * Verifica ámbito resolviendo carreraId a partir de un grupoId en params.
 */
export function requireScopeViaGrupo(key = 'id') {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const user = req.user;
    if (!user) return next(new AppError(401, 'Autenticación requerida'));
    if (user.role === Role.PROPIETARIO) return next();
    if (user.role !== Role.EMBAJADOR) return next(new AppError(403, 'Solo los administradores pueden acceder'));

    const grupoId = (req.params[key] ?? req.body[key] ?? req.query[key]) as string | undefined;
    if (!grupoId) return next(new AppError(400, `Se requiere ${key}`));

    const loc = await locationFromGrupo(grupoId);
    if (!loc) return next(new AppError(404, 'Grupo no encontrado'));
    if (!(await scopeCovers(user.sub, loc))) return next(new AppError(403, 'No tienes ámbito de administración sobre este recurso'));
    next();
  };
}

/**
 * Ámbito resuelto a partir del usuario objetivo (EP-C-28, bloqueo): su carrera
 * y curso deben estar cubiertos por el ámbito del administrador.
 */
export function requireScopeViaUser(key = 'id') {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const user = req.user;
    if (!user) return next(new AppError(401, 'Autenticación requerida'));
    if (user.role === Role.PROPIETARIO) return next();
    if (user.role !== Role.EMBAJADOR) return next(new AppError(403, 'Solo los administradores pueden acceder'));
    const targetId = (req.params[key] ?? req.body?.[key]) as string | undefined;
    if (!targetId) return next(new AppError(400, `Se requiere ${key}`));
    const target = await prisma.user.findFirst({ where: { id: targetId, deletedAt: null }, select: { carreraId: true, cursoId: true } });
    if (!target) return next(new AppError(404, 'Usuario no encontrado'));
    if (!target.carreraId || !target.cursoId || !(await scopeCovers(user.sub, { carreraId: target.carreraId, cursoId: target.cursoId }))) {
      return next(new AppError(403, 'No tienes ámbito de administración sobre este usuario'));
    }
    next();
  };
}
