import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { AppError } from '../middleware/errorHandler';
import * as expedienteService from '../services/expediente.service';

const addSchema = z.object({ asignaturaId: z.string().cuid() });

// ── GET /me/expediente ────────────────────────────────────────
export async function getExpediente(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json(await expedienteService.list(req.user!.sub));
  } catch (err) { next(err); }
}

// ── POST /me/expediente ───────────────────────────────────────
export async function addToExpediente(req: Request, res: Response, next: NextFunction): Promise<void> {
  const parsed = addSchema.safeParse(req.body);
  if (!parsed.success) return next(new AppError(400, parsed.error.errors[0].message));
  try {
    const { created, asignaturaId } = await expedienteService.add(req.user!.sub, parsed.data.asignaturaId);
    res.status(created ? 201 : 200).json({
      message: created ? 'Asignatura añadida al expediente' : 'La asignatura ya estaba en el expediente',
      asignaturaId,
    });
  } catch (err) { next(err); }
}

// ── DELETE /me/expediente/:asignaturaId ───────────────────────
export async function removeFromExpediente(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!z.string().cuid().safeParse(req.params.asignaturaId).success) {
    return next(new AppError(400, 'Identificador de asignatura inválido'));
  }
  try {
    await expedienteService.remove(req.user!.sub, req.params.asignaturaId);
    res.json({ message: 'Asignatura eliminada del expediente' });
  } catch (err) { next(err); }
}
