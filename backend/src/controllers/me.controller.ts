import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { AppError } from '../middleware/errorHandler';
import { prisma } from '../config/prisma';

const addSchema = z.object({ asignaturaId: z.string().cuid() });

// ── GET /api/me/expediente ────────────────────────────────────

export async function getExpediente(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const rows = await prisma.userAsignatura.findMany({
      where: { userId: req.user!.sub },
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
    res.json(rows.map((r) => r.asignatura));
  } catch (err) { next(err); }
}

// ── POST /api/me/expediente ───────────────────────────────────

export async function addToExpediente(req: Request, res: Response, next: NextFunction): Promise<void> {
  const parsed = addSchema.safeParse(req.body);
  if (!parsed.success) return next(new AppError(400, parsed.error.errors[0].message));
  try {
    const { asignaturaId } = parsed.data;
    const asignatura = await prisma.asignatura.findFirst({ where: { id: asignaturaId, deletedAt: null } });
    if (!asignatura) return next(new AppError(404, 'Asignatura no encontrada'));

    await prisma.userAsignatura.upsert({
      where: { userId_asignaturaId: { userId: req.user!.sub, asignaturaId } },
      update: {},
      create: { userId: req.user!.sub, asignaturaId },
    });
    res.status(201).json({ message: 'Asignatura añadida al expediente' });
  } catch (err) { next(err); }
}

// ── DELETE /api/me/expediente/:asignaturaId ───────────────────

export async function removeFromExpediente(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await prisma.userAsignatura.deleteMany({
      where: { userId: req.user!.sub, asignaturaId: req.params.asignaturaId },
    });
    res.json({ message: 'Asignatura eliminada del expediente' });
  } catch (err) { next(err); }
}
