import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import * as offerController from '../controllers/offer.controller';

const router = Router();

// Todas las rutas requieren autenticación
router.use(authenticate);

router.get('/', offerController.listOffers);
router.get('/me', offerController.myOffers);
router.get('/:id', offerController.getOffer);
router.post('/', offerController.createOffer);
router.post('/:id/accept', offerController.acceptOffer);
router.post('/:id/messages', offerController.sendOfferMessage);
router.patch('/:id/close', offerController.closeOffer);

export default router;
