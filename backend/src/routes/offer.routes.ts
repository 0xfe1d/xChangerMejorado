import { Router } from 'express';
import { allowClients, authenticate } from '../middleware/authenticate';
import { idempotency } from '../middleware/idempotency';
import * as offerController from '../controllers/offer.controller';

const router = Router();
const webOrChannel = [allowClients('web', 'channel'), authenticate];

router.get('/', ...webOrChannel, offerController.listOffers);           // EP-C-12
router.get('/me', ...webOrChannel, offerController.myOffers);           // EP-C-13
router.get('/:id', authenticate, offerController.getOffer);             // solo web
router.post('/', ...webOrChannel, idempotency(), offerController.createOffer);                 // EP-R-10
router.post('/:id/accept', ...webOrChannel, idempotency(), offerController.acceptOffer);       // EP-R-11
router.post('/:id/messages', ...webOrChannel, idempotency(), offerController.sendOfferMessage);// EP-R-13
router.patch('/:id/close', ...webOrChannel, offerController.closeOffer);                       // EP-R-12

export default router;
