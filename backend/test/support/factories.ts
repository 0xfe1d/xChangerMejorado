import request from 'supertest';
import type { Express } from 'express';
import { Role } from '@prisma/client';
import { prisma } from '../../src/config/prisma';
import { hashPassword } from '../../src/utils/password';
import { flushOutbox } from '../../src/events/outbox-relay';
import { StreamConsumer } from '../../src/events/stream-consumer';
import { EventEnvelope } from '../../src/events/types';
import { FakeMfaGateway } from './fake-mfa-gateway';

export const PASSWORD = 'Secreta#2026';
export const BOT_SECRET = 'bot-test-secret-0123456789abcdefghijklmnop';

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

export async function seedAcademic() {
  const carrera = await prisma.carrera.create({ data: { nombre: `Informática ${uniq()}` } });
  const curso = await prisma.curso.create({ data: { nombre: '2º', carreraId: carrera.id } });
  const otroCurso = await prisma.curso.create({ data: { nombre: '3º', carreraId: carrera.id } });
  const asignatura = await prisma.asignatura.create({ data: { nombre: 'Redes', codigo: `G-${uniq()}`, cursoId: curso.id } });
  const [g1, g2, g3] = await Promise.all(
    ['P1', 'P2', 'P3'].map((nombre) => prisma.grupo.create({ data: { nombre, asignaturaId: asignatura.id } })),
  );
  return { carrera, curso, otroCurso, asignatura, g1, g2, g3 };
}

export type Academic = Awaited<ReturnType<typeof seedAcademic>>;

export async function createUser(opts: {
  academic: Academic;
  role?: Role;
  name?: string;
  password?: string | null;
  expediente?: boolean;
  email?: string;
  cursoId?: string;
}) {
  const email = (opts.email ?? `u${uniq()}@alumnos.unican.es`).toLowerCase();
  const user = await prisma.user.create({
    data: {
      email,
      name: opts.name ?? `Usuario ${uniq()}`,
      passwordHash: opts.password === null ? null : await hashPassword(opts.password ?? PASSWORD),
      role: opts.role ?? Role.ESTUDIANTE,
      carreraId: opts.academic.carrera.id,
      cursoId: opts.cursoId ?? opts.academic.curso.id,
    },
  });
  if (opts.expediente !== false) {
    await prisma.userAsignatura.create({ data: { userId: user.id, asignaturaId: opts.academic.asignatura.id } });
  }
  return user;
}

/** Agente web con cookies tras un login completo (sin MFA). */
export async function webAgent(app: Express, email: string, password = PASSWORD) {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').send({ email, password });
  if (res.status !== 200 || res.body.mfaRequired) throw new Error(`login falló: ${res.status} ${JSON.stringify(res.body)}`);
  return agent;
}

/** Agente web con login completo incluyendo el segundo factor. */
export async function webAgentWithMfa(app: Express, fake: FakeMfaGateway, userId: string, email: string) {
  const agent = request.agent(app);
  const r1 = await agent.post('/api/auth/login').send({ email, password: PASSWORD });
  if (!r1.body.mfaRequired) throw new Error('se esperaba mfaRequired');
  const r2 = await agent.post('/api/auth/mfa/challenge').send({ code: fake.engine.nextCode(userId) });
  if (r2.status !== 200) throw new Error(`reto MFA falló: ${r2.status} ${JSON.stringify(r2.body)}`);
  return agent;
}

export async function serviceToken(app: Express, scope?: string): Promise<string> {
  const res = await request(app)
    .post('/api/v1/service-auth/token')
    .send({ grant_type: 'client_credentials', client_id: 'telegram-bot', client_secret: BOT_SECRET, ...(scope ? { scope } : {}) });
  if (res.status !== 200) throw new Error(`service token: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.access_token;
}

/** Activa MFA para un usuario usando la API web (EP-C-27 → 21 → 22). */
export async function enableMfa(app: Express, fake: FakeMfaGateway, userId: string, email: string) {
  const agent = await webAgent(app, email);
  await agent.post('/api/v1/auth/reauthenticate').send({ password: PASSWORD }).expect(200);
  const enr = await agent.post('/api/v1/auth/mfa/enrollments').expect(201);
  const conf = await agent
    .post(`/api/v1/auth/mfa/enrollments/${enr.body.enrollmentId}/confirm`)
    .send({ code: fake.engine.nextCode(userId) })
    .expect(200);
  return { agent, recoveryCodes: conf.body.recoveryCodes as string[] };
}

/**
 * Sesión de canal completa por el flujo de vinculación (CA-18):
 * EP-C-03 → aprobación web (EP-C-05) → canje (EP-C-06).
 */
export async function linkChannel(app: Express, email: string, externalUserId = String(100000 + seq++)) {
  const svc = await serviceToken(app);
  const lr = await request(app)
    .post('/api/v1/channel-auth/link-requests')
    .set('X-Service-Authorization', `Bearer ${svc}`)
    .send({ channel: 'telegram', externalUserId, displayName: 'Ana TG' })
    .expect(201);
  const web = await webAgent(app, email);
  await web.post(`/api/v1/channel-links/${lr.body.userCode}/decision`).send({ decision: 'approve' }).expect(200);
  const tok = await request(app)
    .post('/api/v1/channel-auth/token')
    .set('X-Service-Authorization', `Bearer ${svc}`)
    .send({ grant_type: 'link_code', channel: 'telegram', externalUserId, deviceCode: lr.body.deviceCode })
    .expect(200);
  return { svc, externalUserId, accessToken: tok.body.accessToken as string, refreshToken: tok.body.refreshToken as string, session: tok.body };
}

/** Cliente del bot: añade cabecera de servicio + Bearer de canal. */
export function bot(app: Express, svc: string, accessToken: string) {
  const h = (r: request.Test) => r.set('X-Service-Authorization', `Bearer ${svc}`).set('Authorization', `Bearer ${accessToken}`);
  return {
    get: (url: string) => h(request(app).get(url)),
    post: (url: string) => h(request(app).post(url)),
    patch: (url: string) => h(request(app).patch(url)),
    delete: (url: string) => h(request(app).delete(url)),
  };
}

/** Consumidor de prueba que ve el stream como lo vería el bot. */
export function eventCollector() {
  const seen: EventEnvelope[] = [];
  const consumer = new StreamConsumer(`test-${uniq()}`, async (e) => {
    seen.push(e);
  });
  return {
    seen,
    async start() {
      await consumer.ensureGroup();
    },
    async collect() {
      await flushOutbox();
      await consumer.processAvailable();
      return seen;
    },
  };
}
