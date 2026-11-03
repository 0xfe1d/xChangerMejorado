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
    res.json(await adminService.searchSubjectsPublic(String(req.query.q ?? '').trim().slice(0, 100)));
  } catch (err) { next(err); }
});

export default router;
