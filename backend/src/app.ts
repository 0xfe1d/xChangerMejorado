import express, { Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';

import { env } from './config/env';
import { errorHandler, AppError } from './middleware/errorHandler';
import { requestId } from './middleware/requestId';
import { buildApiRouter, healthHandler } from './routes';

/**
 * Composición de la aplicación HTTP (sin abrir puerto ni sockets), de modo que
 * los tests de integración la ejercen con Supertest.
 */
export function createApp(): Express {
  const app = express();

  // AR-02: confiar solo en el número de saltos de proxy configurado (Nginx)
  app.set('trust proxy', env.TRUST_PROXY_HOPS);
  app.disable('x-powered-by');

  app.use(requestId);
  app.use(helmet());
  app.use(
    cors({
      origin: env.FRONTEND_URL,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'Idempotency-Key', 'Accept-Language'],
      exposedHeaders: ['X-Request-Id', 'X-Next-Cursor', 'Retry-After'],
    }),
  );
  app.use(express.json({ limit: '50kb' })); // RV-07
  app.use(express.urlencoded({ extended: false, limit: '50kb' }));
  app.use(cookieParser());

  app.get('/health', healthHandler);

  const api = buildApiRouter();
  app.use('/api/v1', api);
  app.use('/api', api); // alias de v1 para el frontend actual

  app.use((_req, _res, next) => next(new AppError(404, 'Recurso no encontrado', 'NOT_FOUND')));
  app.use(errorHandler);
  return app;
}
