import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import * as authController from '../controllers/auth.controller';

const router = Router();

// Rutas públicas
router.post('/register', authController.register);
router.post('/verify-otp', authController.verifyOtp);
router.post('/login', authController.login);
router.post('/forgot-password', authController.forgotPassword);
router.post('/reset-password', authController.resetPassword);

// Refresh usa su propia cookie (path: /api/auth/refresh), no necesita access_token
router.post('/refresh', authController.refresh);

// Rutas autenticadas
router.post('/logout', authenticate, authController.logout);
router.get('/me', authenticate, authController.me);
router.patch('/me', authenticate, authController.updateMe);
router.patch('/settings/password', authenticate, authController.changePassword);

export default router;
