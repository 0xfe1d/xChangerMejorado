import { Router } from 'express';
import { allowClients, authenticate, requireRecentAuth } from '../middleware/authenticate';
import { idempotency } from '../middleware/idempotency';
import * as meController from '../controllers/me.controller';
import * as notificationController from '../controllers/notification.controller';
import * as channelController from '../controllers/channel.controller';

const router = Router();
const webOrChannel = [allowClients('web', 'channel'), authenticate];

// Expediente (EP-R-05..07)
router.get('/expediente', ...webOrChannel, meController.getExpediente);
router.post('/expediente', ...webOrChannel, idempotency(), meController.addToExpediente);
router.delete('/expediente/:asignaturaId', ...webOrChannel, meController.removeFromExpediente);

// Preferencias de notificación (EP-C-17/18)
router.get('/notification-preferences', ...webOrChannel, notificationController.getPreferences);
router.patch('/notification-preferences', ...webOrChannel, notificationController.updatePreferences);

// Canales vinculados, solo web (EP-C-10/11)
router.get('/channels', authenticate, channelController.listMyChannels);
router.delete('/channels/:identityId', authenticate, requireRecentAuth('login-or-reauth'), channelController.unlinkMyChannel);

export default router;
