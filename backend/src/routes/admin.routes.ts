import { Router } from 'express';
import { Role } from '@prisma/client';
import { authenticate } from '../middleware/authenticate';
import { requireRole, requireScope, requireScopeViaCurso, requireScopeViaAsignatura, requireScopeViaGrupo, requireScopeViaUser } from '../middleware/authorize';
import * as mfaController from '../controllers/mfa.controller';
import * as adminController from '../controllers/admin.controller';

const router = Router();

// Todos los endpoints de admin requieren sesión web: ningún canal accede a /admin (RF-TGB-11)
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
  requireScopeViaCurso('id'), // faltaba la comprobación de ámbito (RF-ACA-09)
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
// EP-C-28: restablecer MFA de un usuario del ámbito
router.post('/users/:id/mfa/reset', isAdmin, requireScopeViaUser('id'), mfaController.adminReset);

// ── Embajadores (solo PROPIETARIO) ───────────────────────────
router.get('/ambassadors', isOwner, adminController.listEmbajadores);
router.post('/ambassadors', isOwner, adminController.promoteEmbajador);
router.delete('/ambassadors/:id', isOwner, adminController.demoteEmbajador);
router.patch('/ambassadors/scope', isOwner, adminController.updateScope);

// ── Logs ──────────────────────────────────────────────────────
router.get('/logs', isAdmin, adminController.getLogs_);

export default router;
