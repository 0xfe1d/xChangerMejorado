import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { AppError } from '../middleware/errorHandler';
import * as adminService from '../services/admin.service';
import { getLogs, getUserLogsPaginated } from '../services/log.service';
import { prisma } from '../config/prisma';

// ── Schemas ───────────────────────────────────────────────────

const carreraSchema = z.object({ nombre: z.string().min(2).max(200) });

const cursoSchema = z.object({
  carreraId: z.string().cuid(),
  nombre: z.string().min(1).max(100),
});

const asignaturaSchema = z.object({
  cursoId: z.string().cuid(),
  nombre: z.string().min(2).max(200),
  codigo: z.string().min(1).max(20),
});

const grupoSchema = z.object({
  asignaturaId: z.string().cuid(),
  nombre: z.string().min(1).max(50),
});

const blockSchema = z.object({
  targetId: z.string().cuid(),
  reason: z.string().min(3).max(500),
  blockedUntil: z.string().datetime().optional().nullable(),
});

const embajadorSchema = z.object({
  targetId: z.string().cuid(),
  scopes: z.array(
    z.object({
      carreraId: z.string().cuid(),
      cursoId: z.string().cuid().optional(),
    }),
  ).min(1),
});

const scopeSchema = z.object({
  targetId: z.string().cuid(),
  scopes: z.array(
    z.object({
      carreraId: z.string().cuid(),
      cursoId: z.string().cuid().optional(),
    }),
  ).min(1),
});

const logsQuerySchema = z.object({
  actionFilter: z.string().optional(),
  userFilter:   z.string().optional(),
  dateFrom:     z.string().optional(),
  dateTo:       z.string().optional(),
  page: z.coerce.number().min(1).default(1),
  pageSize: z.coerce.number().min(1).max(200).default(50),
});

// ── Carreras ──────────────────────────────────────────────────

export async function getCareers(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json(await adminService.listCareers());
  } catch (err) { next(err); }
}

export async function createCarrera(req: Request, res: Response, next: NextFunction): Promise<void> {
  const parsed = carreraSchema.safeParse(req.body);
  if (!parsed.success) return next(new AppError(400, parsed.error.errors[0].message));
  try {
    res.status(201).json(await adminService.createCarrera(parsed.data.nombre, req.user!.sub));
  } catch (err) { next(err); }
}

export async function deleteCarrera(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json(await adminService.deleteCarrera(req.params.id, req.user!.sub));
  } catch (err) { next(err); }
}

// ── Cursos ────────────────────────────────────────────────────

export async function getCursos(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json(await adminService.listCursos(req.params.carreraId));
  } catch (err) { next(err); }
}

export async function createCurso(req: Request, res: Response, next: NextFunction): Promise<void> {
  const parsed = cursoSchema.safeParse(req.body);
  if (!parsed.success) return next(new AppError(400, parsed.error.errors[0].message));
  try {
    res.status(201).json(
      await adminService.createCurso(parsed.data.carreraId, parsed.data.nombre, req.user!.sub),
    );
  } catch (err) { next(err); }
}

export async function deleteCurso(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json(await adminService.deleteCurso(req.params.id, req.user!.sub));
  } catch (err) { next(err); }
}

// ── Asignaturas ───────────────────────────────────────────────

export async function getAsignaturas(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json(await adminService.listAsignaturas(req.params.cursoId));
  } catch (err) { next(err); }
}

export async function createAsignatura(req: Request, res: Response, next: NextFunction): Promise<void> {
  const parsed = asignaturaSchema.safeParse(req.body);
  if (!parsed.success) return next(new AppError(400, parsed.error.errors[0].message));
  try {
    res.status(201).json(
      await adminService.createAsignatura(
        parsed.data.cursoId,
        parsed.data.nombre,
        parsed.data.codigo,
        req.user!.sub,
      ),
    );
  } catch (err) { next(err); }
}

export async function deleteAsignatura(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json(await adminService.deleteAsignatura(req.params.id, req.user!.sub));
  } catch (err) { next(err); }
}

// ── Grupos ────────────────────────────────────────────────────

export async function getGrupos(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json(await adminService.listGrupos(req.params.asignaturaId));
  } catch (err) { next(err); }
}

export async function createGrupo(req: Request, res: Response, next: NextFunction): Promise<void> {
  const parsed = grupoSchema.safeParse(req.body);
  if (!parsed.success) return next(new AppError(400, parsed.error.errors[0].message));
  try {
    res.status(201).json(
      await adminService.createGrupo(parsed.data.asignaturaId, parsed.data.nombre, req.user!.sub),
    );
  } catch (err) { next(err); }
}

export async function deleteGrupo(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json(await adminService.deleteGrupo(req.params.id, req.user!.sub));
  } catch (err) { next(err); }
}

// ── Usuarios ──────────────────────────────────────────────────

export async function blockUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  const parsed = blockSchema.safeParse(req.body);
  if (!parsed.success) return next(new AppError(400, parsed.error.errors[0].message));
  try {
    const blockedUntil = parsed.data.blockedUntil ? new Date(parsed.data.blockedUntil) : null;
    await adminService.blockUser(
      parsed.data.targetId,
      parsed.data.reason,
      blockedUntil,
      req.user!.sub,
      req.user!.role,
    );
    res.json({ message: 'Usuario bloqueado correctamente' });
  } catch (err) { next(err); }
}

export async function unblockUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await adminService.unblockUser(req.params.id, req.user!.sub);
    res.json({ message: 'Usuario desbloqueado correctamente' });
  } catch (err) { next(err); }
}

export async function searchUsers(req: Request, res: Response, next: NextFunction): Promise<void> {
  const q = String(req.query.q ?? '').trim();
  if (!q) return next(new AppError(400, 'Se requiere el parámetro q'));
  try {
    res.json(await adminService.searchUsersInScope(q, req.user!.sub, req.user!.role));
  } catch (err) { next(err); }
}

export async function getUserDetails(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json(await adminService.getUserDetails(req.params.userId, req.user!.sub, req.user!.role));
  } catch (err) { next(err); }
}

const userLogsQuerySchema = z.object({
  page:         z.coerce.number().min(1).default(1),
  pageSize:     z.coerce.number().min(1).max(100).default(25),
  actionFilter: z.string().optional(),
  dateFrom:     z.string().optional(),
  dateTo:       z.string().optional(),
});

export async function getUserLogs_(req: Request, res: Response, next: NextFunction): Promise<void> {
  const parsed = userLogsQuerySchema.safeParse(req.query);
  if (!parsed.success) return next(new AppError(400, parsed.error.errors[0].message));
  try {
    // Verificar ámbito antes de exponer logs
    await adminService.getUserDetails(req.params.userId, req.user!.sub, req.user!.role);
    res.json(
      await getUserLogsPaginated(
        req.params.userId,
        parsed.data.page,
        parsed.data.pageSize,
        parsed.data.actionFilter,
        parsed.data.dateFrom,
        parsed.data.dateTo,
      ),
    );
  } catch (err) { next(err); }
}

const forcePasswordSchema = z.object({ newPassword: z.string().min(8) });

export async function adminForcePassword(req: Request, res: Response, next: NextFunction): Promise<void> {
  const parsed = forcePasswordSchema.safeParse(req.body);
  if (!parsed.success) return next(new AppError(400, parsed.error.errors[0].message));
  try {
    await adminService.adminForcePasswordChange(req.params.userId, parsed.data.newPassword, req.user!.sub, req.user!.role);
    res.json({ message: 'Contraseña actualizada. La sesión del usuario ha sido revocada.' });
  } catch (err) { next(err); }
}

// ── Embajadores ───────────────────────────────────────────────

export async function promoteEmbajador(req: Request, res: Response, next: NextFunction): Promise<void> {
  const parsed = embajadorSchema.safeParse(req.body);
  if (!parsed.success) return next(new AppError(400, parsed.error.errors[0].message));
  try {
    await adminService.promoteToEmbajador(parsed.data.targetId, parsed.data.scopes, req.user!.sub);
    res.json({ message: 'Embajador creado correctamente' });
  } catch (err) { next(err); }
}

export async function demoteEmbajador(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await adminService.demoteEmbajador(req.params.id, req.user!.sub);
    res.json({ message: 'Embajador eliminado correctamente' });
  } catch (err) { next(err); }
}

export async function updateScope(req: Request, res: Response, next: NextFunction): Promise<void> {
  const parsed = scopeSchema.safeParse(req.body);
  if (!parsed.success) return next(new AppError(400, parsed.error.errors[0].message));
  try {
    await adminService.updateAdminScope(parsed.data.targetId, parsed.data.scopes, req.user!.sub);
    res.json({ message: 'Ámbito actualizado correctamente' });
  } catch (err) { next(err); }
}

export async function listEmbajadores(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json(await adminService.repository.findEmbajadores());
  } catch (err) { next(err); }
}

// ── Logs ──────────────────────────────────────────────────────

export async function getLogs_(req: Request, res: Response, next: NextFunction): Promise<void> {
  const parsed = logsQuerySchema.safeParse(req.query);
  if (!parsed.success) return next(new AppError(400, parsed.error.errors[0].message));

  try {
    const scopes = await prisma.adminScope.findMany({ where: { userId: req.user!.sub } });
    const carreraIds = scopes.map((s) => s.carreraId);
    const cursoIds = scopes.flatMap((s) => (s.cursoId ? [s.cursoId] : []));

    res.json(
      await getLogs({
        carreraIds,
        cursoIds,
        actionFilter: parsed.data.actionFilter,
        userFilter:   parsed.data.userFilter,
        dateFrom:     parsed.data.dateFrom,
        dateTo:       parsed.data.dateTo,
        page:     parsed.data.page,
        pageSize: parsed.data.pageSize,
      }),
    );
  } catch (err) { next(err); }
}
