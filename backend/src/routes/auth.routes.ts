import { Router } from 'express';
import { allowClients, authenticate } from '../middleware/authenticate';
import { rateLimit, byIp, byBody } from '../middleware/rateLimit';
import * as authController from '../controllers/auth.controller';
import * as mfaController from '../controllers/mfa.controller';
import { requireRecentAuth } from '../middleware/authenticate';

const router = Router();
const web = [authenticate];
const webOrChannel = [allowClients('web', 'channel'), authenticate];

// RNF-03 / DV-08: límites por IP y por cuenta, compartidos en Redis
const loginLimit = rateLimit(
  { name: 'login:ip', limit: 20, windowSec: 15 * 60, key: byIp },
  { name: 'login:email', limit: 10, windowSec: 15 * 60, key: byBody('email') },
);
const otpLimit = rateLimit({ name: 'otp:ip', limit: 20, windowSec: 15 * 60, key: byIp });
const recoveryLimit = rateLimit(
  { name: 'recovery:ip', limit: 10, windowSec: 15 * 60, key: byIp },
  { name: 'recovery:email', limit: 5, windowSec: 15 * 60, key: byBody('email') },
);
const mfaLimit = rateLimit({ name: 'mfa:ip', limit: 30, windowSec: 5 * 60, key: byIp });

// ── Públicas ──────────────────────────────────────────────────
router.post('/register', otpLimit, authController.register);
router.post('/verify-otp', otpLimit, authController.verifyOtp);
router.post('/login', loginLimit, authController.login);
router.post('/forgot-password', recoveryLimit, authController.forgotPassword);
router.post('/reset-password', recoveryLimit, authController.resetPassword);
router.post('/refresh', authController.refresh);
// EP-C-24: acceso por cookie de reto
router.post('/mfa/challenge', mfaLimit, authController.mfaChallenge);

// ── Autenticadas ──────────────────────────────────────────────
router.post('/logout', ...web, authController.logout);
router.get('/me', ...webOrChannel, authController.me);
router.patch('/me', ...web, authController.updateMe);
router.patch('/settings/password', ...web, authController.changePassword);
router.post('/reauthenticate', mfaLimit, ...web, authController.reauthenticate);

// ── MFA (EP-C-20..26) ─────────────────────────────────────────
router.get('/mfa', ...webOrChannel, mfaController.status);
router.post('/mfa/enrollments', ...web, requireRecentAuth('reauth'), mfaController.startEnrollment);
router.post('/mfa/enrollments/:enrollmentId/confirm', mfaLimit, ...web, mfaController.confirmEnrollment);
router.delete('/mfa/enrollments/:enrollmentId', ...web, mfaController.cancelEnrollment);
router.post('/mfa/disable', mfaLimit, ...web, mfaController.disable);
router.post('/mfa/recovery-codes', mfaLimit, ...web, mfaController.regenerateRecoveryCodes);

export default router;
