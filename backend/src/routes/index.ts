import { Router, Request, Response } from 'express';
import authRouter from './auth.routes';
import offerRouter from './offer.routes';
import ticketRouter from './ticket.routes';
import adminRouter from './admin.routes';
import notificationRouter from './notification.routes';
import publicRouter from './public.routes';
import meRouter from './me.routes';
import subjectRouter from './subject.routes';
import { channelAuthRouter, channelLinksRouter, serviceAuthRouter, internalRouter } from './channel.routes';
import * as health from '../services/health.service';

/** GET /health (EP-C-30). El timestamp sirve a la app XOTP para detectar desajuste de reloj. */
export async function healthHandler(req: Request, res: Response): Promise<void> {
  const body: Record<string, unknown> = { status: 'ok', timestamp: new Date().toISOString() };
  if (req.query.deep === 'true' && health.isInternalIp(req.ip)) {
    const deps = await health.dependencies();
    body.dependencies = deps;
    if (deps.db === 'down' || deps.redis === 'down') body.status = 'degraded';
  }
  res.json(body);
}

/** Router de la API pública versionada. Se monta en /api/v1 y, como alias, en /api (§5.6). */
export function buildApiRouter(): Router {
  const api = Router();
  api.use('/auth', authRouter);
  api.use('/offers', offerRouter);
  api.use('/tickets', ticketRouter);
  api.use('/admin', adminRouter);
  api.use('/notifications', notificationRouter);
  api.use('/public', publicRouter);
  api.use('/me', meRouter);
  api.use('/subjects', subjectRouter);
  api.use('/channel-auth', channelAuthRouter);
  api.use('/channel-links', channelLinksRouter);
  // Infraestructura de servicios: Nginx devuelve 404 para estas rutas (§12.2)
  api.use('/service-auth', serviceAuthRouter);
  api.use('/internal', internalRouter);
  api.get('/health', healthHandler);
  return api;
}
