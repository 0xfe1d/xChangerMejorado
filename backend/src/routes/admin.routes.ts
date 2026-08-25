import { Router } from 'express';
import { Role } from '@prisma/client';
import { authenticate } from '../middleware/authenticate';
import { requireRole, requireScope, requireScopeViaCurso, requireScopeViaAsignatura, requireScopeViaGrupo } from '../middleware/authorize';
import * as adminController from '../controllers/admin.controller';

const router = Router();

// Todos los endpoints de admin requieren autenticación
router.use(authenticate);

// Solo EMBAJADOR o PROPIETARIO
const isAdmin = requireRole(Role.EMBAJADOR, Role.PROPIETARIO);
// Solo PROPIETARIO
const isOwner = requireRole(Role.PROPIETARIO);

// ── Carreras ──────────────────────────────────────────────────
router.get('/careers', isAdmin, adminController.getCareers);
router.post('/careers', isOwner, adminController.createCarrera);
router.delete('/careers/:id', isOwner, adminController.deleteCarrera);

// ── Cursos ────────────────────────────────────────────────────
// requireScope verifica que el embajador tenga ámbito sobre esa carrera
router.get(
  '/careers/:carreraId/courses',
  isAdmin,
  requireScope({ carreraParam: 'carreraId' }),
  adminController.getCursos,
);
router.post(
  '/courses',
  isAdmin,
  requireScope(),
  adminController.createCurso,
);
router.delete(
  '/courses/:id',
  isAdmin,
  adminController.deleteCurso,
);

// ── Asignaturas ───────────────────────────────────────────────
router.get('/courses/:cursoId/subjects', isAdmin, requireScopeViaCurso('cursoId'), adminController.getAsignaturas);
router.post('/subjects', isAdmin, requireScopeViaCurso(), adminController.createAsignatura);
router.delete('/subjects/:id', isAdmin, requireScopeViaAsignatura('id'), adminController.deleteAsignatura);

// ── Grupos ────────────────────────────────────────────────────
router.get('/subjects/:asignaturaId/groups', isAdmin, requireScopeViaAsignatura('asignaturaId'), adminController.getGrupos);
router.post('/groups', isAdmin, requireScopeViaAsignatura(), adminController.createGrupo);
router.delete('/groups/:id', isAdmin, requireScopeViaGrupo(), adminController.deleteGrupo);

// ── Usuarios / Bloqueo / Auditoría ───────────────────────────
router.get('/users/search', isAdmin, adminController.searchUsers);
router.get('/users/:userId/details', isAdmin, adminController.getUserDetails);
router.get('/users/:userId/logs', isAdmin, adminController.getUserLogs_);
router.post('/users/block', isAdmin, adminController.blockUser);
router.patch('/users/:id/unblock', isAdmin, adminController.unblockUser);
router.patch('/users/:userId/password', isAdmin, adminController.adminForcePassword);

// ── Embajadores (solo PROPIETARIO) ───────────────────────────
router.get('/ambassadors', isOwner, adminController.listEmbajadores);
router.post('/ambassadors', isOwner, adminController.promoteEmbajador);
router.delete('/ambassadors/:id', isOwner, adminController.demoteEmbajador);
router.patch('/ambassadors/scope', isOwner, adminController.updateScope);

// ── Logs ──────────────────────────────────────────────────────
router.get('/logs', isAdmin, adminController.getLogs_);

export default router;
