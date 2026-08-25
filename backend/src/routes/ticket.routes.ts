import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { requireRole } from '../middleware/authorize';
import { Role } from '@prisma/client';
import * as ticketController from '../controllers/ticket.controller';

const router = Router();

router.use(authenticate);

// Rutas de usuario
router.post('/', ticketController.openTicket);
router.get('/me', ticketController.myTickets);
router.get('/:id', ticketController.getTicket);
router.patch('/:id/close', ticketController.closeTicket);
router.post('/:id/messages', ticketController.sendMessage);

// Rutas de administración
router.get(
  '/admin/list',
  requireRole(Role.EMBAJADOR, Role.PROPIETARIO),
  ticketController.adminTickets,
);

export default router;
