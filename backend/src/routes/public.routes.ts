import { Router, Request, Response, NextFunction } from 'express';
import * as adminService from '../services/admin.service';
import { prisma } from '../config/prisma';

const router = Router();

// Listado de carreras accesible sin autenticación (necesario en el formulario de registro)
router.get('/careers', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await adminService.listCareers());
  } catch (err) {
    next(err);
  }
});

// Cursos de una carrera, también público para el desplegable de registro
router.get('/careers/:carreraId/courses', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await adminService.listCursos(req.params.carreraId));
  } catch (err) {
    next(err);
  }
});

// Búsqueda global de asignaturas (para módulo expediente en settings)
router.get('/subjects/search', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const q = String(req.query.q ?? '').trim();
    const subjects = await prisma.asignatura.findMany({
      where: {
        deletedAt: null,
        ...(q
          ? {
              OR: [
                { nombre: { contains: q, mode: 'insensitive' } },
                { codigo: { contains: q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      include: {
        grupos: { where: { deletedAt: null }, orderBy: { nombre: 'asc' } },
        curso: { select: { id: true, nombre: true, carrera: { select: { nombre: true } } } },
      },
      orderBy: { nombre: 'asc' },
      take: 20,
    });
    res.json(subjects);
  } catch (err) { next(err); }
});

export default router;
