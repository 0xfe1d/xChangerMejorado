import 'dotenv/config';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';

import { env } from './config/env';
import { prisma } from './config/prisma';
import { getRedis, closeRedis } from './config/redis';
import { createApp } from './app';
import { initSocketServer } from './sockets/socket.server';
import { initServiceKeys } from './services/service-auth.service';
import { startOutboxRelay, stopOutboxRelay } from './events/outbox-relay';
import { CORE_CONSUMERS } from './events/consumers';

const app = createApp();
const httpServer = createServer(app);

export const io = new SocketIOServer(httpServer, {
  cors: { origin: env.FRONTEND_URL, credentials: true },
  connectionStateRecovery: { maxDisconnectionDuration: 2 * 60 * 1000 },
});

async function bootstrap(): Promise<void> {
  // RNF-05: comprobar dependencias antes de aceptar tráfico
  await prisma.$connect();
  await getRedis().ping();
  await initServiceKeys();

  initSocketServer(io);
  startOutboxRelay(env.OUTBOX_POLL_MS);
  for (const c of CORE_CONSUMERS) c.start();

  httpServer.listen(env.PORT, () => {
    console.log(`[server] xChanger core en http://localhost:${env.PORT} (${env.NODE_ENV})`);
  });
}

async function shutdown(signal: string): Promise<void> {
  console.log(`[server] señal ${signal} recibida. Cerrando...`);
  stopOutboxRelay();
  await Promise.all(CORE_CONSUMERS.map((c) => c.stop()));
  io.close();
  httpServer.close(async () => {
    await prisma.$disconnect();
    await closeRedis();
    process.exit(0);
  });
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

bootstrap().catch((err) => {
  console.error('[server] error fatal al arrancar:', err);
  process.exit(1);
});
