import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { allowClients, authenticate } from '../middleware/authenticate';
import { AppError } from '../middleware/errorHandler';
import * as adminService from '../services/admin.service';

const router = Router();

// EP-C-14 — W, S+U
router.get('/:asignaturaId/groups', allowClients('web', 'channel'), authenticate, async (req: Request, res: Response, next: NextFunction) => {
  if (!z.string().cuid().safeParse(req.params.asignaturaId).success) return next(new AppError(400, 'Identificador inválido'));
  try {
    res.json(await adminService.listGroupsForSubject(req.params.asignaturaId));
  } catch (err) { next(err); }
});

export default router;
