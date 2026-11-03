// Cypress como cliente HTTP externo de la API del core (no hay UI que probar).
// Las tareas de Node preparan datos y leen los OTP desde Mailpit.
const path = require('path');
const { defineConfig } = require('cypress');

const backend = path.resolve(__dirname, '..');
require(path.join(backend, 'node_modules/dotenv')).config({ path: path.join(backend, '.env.test'), quiet: true });
const { PrismaClient } = require(path.join(backend, 'node_modules/@prisma/client'));
const bcrypt = require(path.join(backend, 'node_modules/bcrypt'));
const Redis = require(path.join(backend, 'node_modules/ioredis'));

const prisma = new PrismaClient();
const redis = new Redis(process.env.REDIS_URL);
const MAILPIT = 'http://localhost:58025';
const MFA_STUB = 'http://localhost:58081';
const PASSWORD = 'Secreta#2026';

const TABLES = [
  'outbox', 'notification_preferences', 'channel_login_challenges', 'channel_link_requests', 'channel_sessions',
  'channel_identities', 'messages', 'offers', 'tickets', 'notifications', 'logs', 'login_history',
  'password_reset_requests', 'pending_registrations', 'user_asignaturas', 'admin_scopes', 'grupos', 'asignaturas',
  'cursos', 'users', 'carreras',
];

async function resetAll() {
  await prisma.$executeRawUnsafe(`TRUNCATE ${TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
  // Se conservan los grupos de consumidores del core: solo se limpian claves de estado
  const keys = await redis.keys('rl:*');
  const more = await redis.keys('idem:*');
  if (keys.length + more.length) await redis.del(...keys, ...more);
  await fetch(`${MAILPIT}/api/v1/messages`, { method: 'DELETE' });
  await fetch(`${MFA_STUB}/__test/reset`, { method: 'POST' });
  return null;
}

async function seed() {
  const carrera = await prisma.carrera.create({ data: { nombre: 'Grado en Informática' } });
  const curso = await prisma.curso.create({ data: { nombre: '2º', carreraId: carrera.id } });
  const asignatura = await prisma.asignatura.create({ data: { nombre: 'Redes', codigo: 'G-RED', cursoId: curso.id } });
  const grupos = [];
  for (const nombre of ['P1', 'P2', 'P3']) grupos.push(await prisma.grupo.create({ data: { nombre, asignaturaId: asignatura.id } }));
  const hash = await bcrypt.hash(PASSWORD, 10);
  const mk = async (email, name, role = 'ESTUDIANTE') => {
    const u = await prisma.user.create({ data: { email, name, passwordHash: hash, role, carreraId: carrera.id, cursoId: curso.id } });
    await prisma.userAsignatura.create({ data: { userId: u.id, asignaturaId: asignatura.id } });
    return { id: u.id, email };
  };
  const ana = await mk('ana@alumnos.unican.es', 'Ana Pérez');
  const beto = await mk('beto@alumnos.unican.es', 'Beto Ruiz');
  const owner = await mk('owner@alumnos.unican.es', 'Propietaria', 'PROPIETARIO');
  return { carreraId: carrera.id, cursoId: curso.id, asignaturaId: asignatura.id, g1: grupos[0].id, g2: grupos[1].id, g3: grupos[2].id, ana, beto, owner, password: PASSWORD };
}

/** Último OTP enviado a una dirección (con reintentos mientras llega el correo). */
async function otpFor(email) {
  for (let i = 0; i < 30; i++) {
    const r = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}" subject:"código de verificación"`)}&limit=1`);
    const data = await r.json();
    const id = data.messages?.[0]?.ID;
    if (id) {
      const msg = await (await fetch(`${MAILPIT}/api/v1/message/${id}`)).json();
      const m = String(msg.HTML || msg.Text).match(/>\s*(\d{6})\s*</) || String(msg.Text).match(/\b(\d{6})\b/);
      if (m) return m[1];
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`No llegó OTP a ${email}`);
}

async function mailCount(email) {
  const r = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`);
  return (await r.json()).messages_count ?? 0;
}

module.exports = defineConfig({
  e2e: {
    baseUrl: 'http://localhost:3100',
    supportFile: 'cypress/support/e2e.js',
    specPattern: 'cypress/e2e/**/*.cy.js',
    video: false,
    env: { botSecret: 'bot-test-secret-0123456789abcdefghijklmnop', mfaStub: MFA_STUB },
    setupNodeEvents(on) {
      on('task', {
        resetAll,
        seed,
        otpFor,
        mailCount,
        async mfaCode(subjectId) {
          return (await (await fetch(`${MFA_STUB}/__test/code/${subjectId}`)).json()).code;
        },
        async mfaDown(down) {
          await fetch(`${MFA_STUB}/__test/down`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ down }) });
          return null;
        },
        async mfaAdvance(ms) {
          await fetch(`${MFA_STUB}/__test/advance`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ms }) });
          return null;
        },
        async dbQuery({ model, where }) {
          return prisma[model].findMany({ where });
        },
      });
    },
  },
});
