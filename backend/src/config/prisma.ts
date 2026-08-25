import { PrismaClient } from '@prisma/client';
import { env } from './env';

// Singleton PrismaClient. En desarrollo, el hot-reload puede crear
// múltiples instancias si no se usa el global de Node.js.
const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      env.NODE_ENV === 'development'
        ? ['query', 'info', 'warn', 'error']
        : ['warn', 'error'],
  });

if (env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
