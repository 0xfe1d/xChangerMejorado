import { Router } from 'express';
import { allowClients, authenticate, requireService, requireRecentAuth } from '../middleware/authenticate';
import { rateLimit, byIp, byBody } from '../middleware/rateLimit';
import { idempotency } from '../middleware/idempotency';
import * as c from '../controllers/channel.controller';

// ── /channel-auth (consumido por el bot) ──────────────────────
export const channelAuthRouter = Router();
const svc = requireService('channel:telegram');

channelAuthRouter.post(
  '/link-requests',
  svc,
  rateLimit({ name: 'link:ext', limit: 5, windowSec: 3600, key: byBody('externalUserId') }),
  c.createLinkRequest,
);
channelAuthRouter.post(
  '/token',
  svc,
  // El sondeo de link_code va aparte del resto para no agotar el límite general
  rateLimit({ name: 'ctoken:ext', limit: 60, windowSec: 15 * 60, key: (req) => (req.body?.grant_type === 'link_code' ? undefined : byBody('externalUserId')(req)) }),
  c.token,
);
channelAuthRouter.post(
  '/email-otp',
  svc,
  rateLimit(
    { name: 'cotp:email', limit: 3, windowSec: 15 * 60, key: byBody('email') },
    { name: 'cotp:ext', limit: 5, windowSec: 3600, key: byBody('externalUserId') },
  ),
  c.emailOtp,
);
channelAuthRouter.post(
  '/register',
  svc,
  rateLimit({ name: 'creg:ext', limit: 5, windowSec: 3600, key: byBody('externalUserId') }, { name: 'creg:ip', limit: 30, windowSec: 3600, key: byIp }),
  idempotency(),
  c.register,
);
channelAuthRouter.post('/revoke', allowClients('channel'), authenticate, c.revoke);

// ── /channel-links (página de aprobación web) ─────────────────
export const channelLinksRouter = Router();
channelLinksRouter.get('/:userCode', authenticate, c.getLinkRequest);
channelLinksRouter.post('/:userCode/decision', authenticate, requireRecentAuth('login-or-reauth'), c.decideLinkRequest);

// ── Infraestructura de servicios (Nginx NO enruta estas rutas) ─
export const serviceAuthRouter = Router();
serviceAuthRouter.post('/token', rateLimit({ name: 'svc:ip', limit: 30, windowSec: 60, key: byIp }), c.serviceToken);

export const internalRouter = Router();
internalRouter.get('/.well-known/jwks.json', c.jwks);
