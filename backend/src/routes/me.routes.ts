import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import * as meController from '../controllers/me.controller';

const router = Router();

router.use(authenticate);

router.get('/expediente', meController.getExpediente);
router.post('/expediente', meController.addToExpediente);
router.delete('/expediente/:asignaturaId', meController.removeFromExpediente);

export default router;
