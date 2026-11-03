import { Router } from 'express';
import { allowClients, authenticate } from '../middleware/authenticate';
import * as notificationController from '../controllers/notification.controller';

const router = Router();

// EP-R-14..16 — W, S+U
router.use(allowClients('web', 'channel'), authenticate);

router.get('/unread-count', notificationController.getUnreadCount);
router.get('/', notificationController.getNotifications);
router.patch('/read-all', notificationController.markAllAsRead);
router.patch('/:id/read', notificationController.markAsRead);

export default router;
