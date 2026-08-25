import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';

import { env } from './config/env';
import { prisma } from './config/prisma';
import { errorHandler } from './middleware/errorHandler';
import authRouter from './routes/auth.routes';
import offerRouter from './routes/offer.routes';
import ticketRouter from './routes/ticket.routes';
import adminRouter from './routes/admin.routes';
import notificationRouter from './routes/notification.routes';
import publicRouter from './routes/public.routes';
import meRouter from './routes/me.routes';
import { initSocketServer } from './sockets/socket.server';

// ── Express App ───────────────────────────────────────────────
const app = express();
const httpServer = createServer(app);

// ── Middlewares globales ──────────────────────────────────────

// Helmet establece cabeceras HTTP de seguridad (CSP, HSTS, etc.)
app.use(helmet());

app.use(
  cors({
    origin: env.FRONTEND_URL,
    credentials: true, // necesario para enviar cookies HttpOnly cross-origin
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }),
);

app.use(express.json({ limit: '50kb' }));
app.use(express.urlencoded({ extended: false }));
// Cookie parser sin secret; los JWT van en cookies HttpOnly firmadas por sí mismos
app.use(cookieParser());

// ── Health check ──────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Rutas de la API ───────────────────────────────────────────
app.use('/api/auth', authRouter);
app.use('/api/offers', offerRouter);
app.use('/api/tickets', ticketRouter);
app.use('/api/admin', adminRouter);
app.use('/api/notifications', notificationRouter);
app.use('/api/public', publicRouter);
app.use('/api/me', meRouter);

// ── Manejador de errores (debe ir al final) ───────────────────
app.use(errorHandler);

// ── Socket.io ─────────────────────────────────────────────────
export const io = new SocketIOServer(httpServer, {
  cors: {
    origin: env.FRONTEND_URL,
    credentials: true,
  },
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000,
  },
});

initSocketServer(io);

// ── Arranque del servidor ─────────────────────────────────────
async function bootstrap(): Promise<void> {
  // Verificar conectividad con la base de datos antes de aceptar tráfico
  await prisma.$connect();
  console.log('[db] conexión establecida con PgBouncer/PostgreSQL');

  httpServer.listen(env.PORT, () => {
    console.log(`[server] xChanger backend corriendo en http://localhost:${env.PORT}`);
    console.log(`[server] entorno: ${env.NODE_ENV}`);
  });
}

// Cierre limpio
async function shutdown(signal: string): Promise<void> {
  console.log(`[server] señal ${signal} recibida. Cerrando...`);
  await prisma.$disconnect();
  httpServer.close(() => {
    console.log('[server] servidor cerrado.');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

bootstrap().catch((err) => {
  console.error('[server] error fatal al arrancar:', err);
  process.exit(1);
});
