import { Router, Request, Response, NextFunction } from 'express';
import * as adminService from '../services/admin.service';

const router = Router();

// RF-ACA-08: catálogo necesario para el registro, sin sesión
router.get('/careers', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await adminService.listCareers());
  } catch (err) { next(err); }
});

router.get('/careers/:carreraId/courses', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await adminService.listCursos(req.params.carreraId));
  } catch (err) { next(err); }
});

router.get('/subjects/search', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const q = String(req.query.q ?? '').trim().slice(0, 100);
    const carreraId =
      typeof req.query.carreraId === 'string' && req.query.carreraId ? req.query.carreraId : undefined;
    const cursoId =
      typeof req.query.cursoId === 'string' && req.query.cursoId ? req.query.cursoId : undefined;
    const rawLimit = req.query.limit !== undefined ? Number(req.query.limit) : undefined;
    const rawOffset = req.query.offset !== undefined ? Number(req.query.offset) : undefined;
    const limit =
      rawLimit !== undefined && Number.isInteger(rawLimit) && rawLimit >= 1 && rawLimit <= 50
        ? rawLimit
        : undefined;
    const offset =
      rawOffset !== undefined && Number.isInteger(rawOffset) && rawOffset >= 0
        ? rawOffset
        : undefined;

    res.json(await adminService.searchSubjectsPublic(q, { carreraId, cursoId, limit, offset }));
  } catch (err) { next(err); }
});

export default router;
