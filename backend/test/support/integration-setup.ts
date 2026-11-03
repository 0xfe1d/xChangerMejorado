import { mailbox } from './mailbox';

// El SMTP se sustituye por un buzón en memoria (los OTP se leen desde aquí)
jest.mock('../../src/services/email.service', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { mailbox: box } = require('./mailbox');
  return {
    sendOtpEmail: jest.fn(async (to: string, otp: string) => {
      box.push({ to: to.toLowerCase(), subject: 'otp', otp });
    }),
    sendNotificationEmail: jest.fn(async (to: string, subject: string, html: string) => {
      box.push({ to: to.toLowerCase(), subject, html });
    }),
  };
});

import { prisma } from '../../src/config/prisma';
import { getRedis, closeRedis } from '../../src/config/redis';
import { initServiceKeys } from '../../src/services/service-auth.service';
import { setMfaGateway } from '../../src/services/mfa/mfa.http-client';
import { FakeMfaGateway } from './fake-mfa-gateway';

export const fakeMfa = new FakeMfaGateway();
(globalThis as any).__fakeMfa = fakeMfa;

const TABLES = [
  'outbox', 'notification_preferences', 'channel_login_challenges', 'channel_link_requests', 'channel_sessions',
  'channel_identities', 'messages', 'offers', 'tickets', 'notifications', 'logs', 'login_history',
  'password_reset_requests', 'pending_registrations', 'user_asignaturas', 'admin_scopes', 'grupos', 'asignaturas',
  'cursos', 'users', 'carreras',
];

beforeAll(async () => {
  await initServiceKeys();
  setMfaGateway(fakeMfa);
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe(`TRUNCATE ${TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
  await getRedis().flushdb();
  fakeMfa.engine.reset();
  fakeMfa.engine.now = () => Date.now();
  mailbox.length = 0;
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeRedis();
});
