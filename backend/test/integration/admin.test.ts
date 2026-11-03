import request from 'supertest';
import { Role } from '@prisma/client';
import { prisma } from '../../src/config/prisma';
import { createApp } from '../../src/app';
import { seedAcademic, createUser, webAgent, Academic, eventCollector, PASSWORD } from '../support/factories';

const app = createApp();
let ac: Academic;
beforeEach(async () => {
  ac = await seedAcademic();
});

async function embajador(academic: Academic, cursoId?: string) {
  const u = await createUser({ academic, role: Role.EMBAJADOR });
  await prisma.adminScope.create({ data: { userId: u.id, carreraId: academic.carrera.id, cursoId: cursoId ?? null } });
  return u;
}

describe('RS-09 Bloqueo', () => {
  it('CA-07: un embajador de la carrera X no puede bloquear a un estudiante de Y (403, sin cambios)', async () => {
    const otra = await seedAcademic();
    const emb = await embajador(ac);
    const victim = await createUser({ academic: otra });
    const agent = await webAgent(app, emb.email);
    await agent.post('/api/admin/users/block').send({ targetId: victim.id, reason: 'motivo de prueba' }).expect(403);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: victim.id } })).role).toBe('ESTUDIANTE');
  });

  it('CA-08: el bloqueo pasa sus ofertas a INACTIVE, invalida la sesión y publica account.blocked', async () => {
    const events = eventCollector();
    await events.start();
    const emb = await embajador(ac);
    const victim = await createUser({ academic: ac });
    const victimAgent = await webAgent(app, victim.email);
    const offer = await victimAgent.post('/api/offers').send({ asignaturaId: ac.asignatura.id, grupoActualId: ac.g1.id, grupoDeseadoId: ac.g2.id }).expect(201);

    await (await webAgent(app, emb.email)).post('/api/admin/users/block').send({ targetId: victim.id, reason: 'motivo de prueba' }).expect(200);

    expect((await prisma.offer.findUniqueOrThrow({ where: { id: offer.body.id } })).status).toBe('INACTIVE');
    const denied = await victimAgent.get('/api/offers/me');
    expect(denied.status).toBe(403); // RF-BLQ-04: el access token aún válido ya no sirve
    expect(denied.body.code).toBe('ACCOUNT_BLOCKED');
    const ev = (await events.collect()).find((e) => e.type === 'account.blocked')!;
    expect(ev.data).toMatchObject({ userId: victim.id, permanent: true, reason: 'motivo de prueba' });
    await new Promise((r) => setTimeout(r, 100));
    expect(await prisma.log.count({ where: { action: 'BLOCK_USER' } })).toBe(1);
  });

  it('CA-09: al vencer un bloqueo temporal la cuenta puede entrar sin intervención (DV-01)', async () => {
    const victim = await createUser({ academic: ac });
    await prisma.user.update({ where: { id: victim.id }, data: { role: 'BLOQUEADO', blockedUntil: new Date(Date.now() - 1000), blockReason: 'temporal' } });
    await request(app).post('/api/auth/login').send({ email: victim.email, password: PASSWORD }).expect(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: victim.id } })).role).toBe('ESTUDIANTE');
  });

  it('DV-02 / RF-BLQ-02: nadie se bloquea a sí mismo ni bloquea a un Propietario; un embajador solo a estudiantes', async () => {
    const owner = await createUser({ academic: ac, role: Role.PROPIETARIO });
    const owner2 = await createUser({ academic: ac, role: Role.PROPIETARIO });
    const emb = await embajador(ac);
    const emb2 = await embajador(ac);
    const ownerAgent = await webAgent(app, owner.email);
    await ownerAgent.post('/api/admin/users/block').send({ targetId: owner.id, reason: 'yo mismo' }).expect(403);
    await ownerAgent.post('/api/admin/users/block').send({ targetId: owner2.id, reason: 'otro propietario' }).expect(403);
    await (await webAgent(app, emb.email)).post('/api/admin/users/block').send({ targetId: emb2.id, reason: 'otro embajador' }).expect(403);
  });

  it('RF-BLQ-06: desbloquear devuelve el rol Estudiante; si no estaba bloqueado → 409', async () => {
    const emb = await embajador(ac);
    const victim = await createUser({ academic: ac });
    const agent = await webAgent(app, emb.email);
    await agent.patch(`/api/admin/users/${victim.id}/unblock`).expect(409);
    await agent.post('/api/admin/users/block').send({ targetId: victim.id, reason: 'motivo temporal', blockedUntil: new Date(Date.now() + 3600_000).toISOString() }).expect(200);
    await agent.patch(`/api/admin/users/${victim.id}/unblock`).expect(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: victim.id } })).role).toBe('ESTUDIANTE');
  });
});

describe('RS-03 Estructura académica', () => {
  it('CA-10: eliminar una asignatura con ofertas cancela las ofertas y notifica a los afectados (RF-ACA-06)', async () => {
    const owner = await createUser({ academic: ac, role: Role.PROPIETARIO });
    const a = await createUser({ academic: ac });
    const offer = await (await webAgent(app, a.email)).post('/api/offers').send({ asignaturaId: ac.asignatura.id, grupoActualId: ac.g1.id, grupoDeseadoId: ac.g2.id }).expect(201);
    const events = eventCollector();
    await events.start();
    await (await webAgent(app, owner.email)).delete(`/api/admin/subjects/${ac.asignatura.id}`).expect(200);
    expect((await prisma.offer.findUniqueOrThrow({ where: { id: offer.body.id } })).status).toBe('CLOSED');
    expect(await prisma.notification.count({ where: { userId: a.id, asunto: 'Aviso del sistema' } })).toBe(1);
    const types = (await events.collect()).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['offer.status.changed', 'academic.changed']));
    // RF-ACA-07: ya no aparece en el catálogo
    const search = await request(app).get(`/api/public/subjects/search?q=${ac.asignatura.codigo}`).expect(200);
    expect(search.body).toEqual([]);
  });

  it('AR-05: un embajador con ámbito de un curso puede gestionar grupos de ese curso y no de otro', async () => {
    const emb = await embajador(ac, ac.curso.id);
    const agent = await webAgent(app, emb.email);
    await agent.get(`/api/admin/subjects/${ac.asignatura.id}/groups`).expect(200);
    const ajena = await prisma.asignatura.create({ data: { nombre: 'Ajena', codigo: `AJ-${Date.now()}`, cursoId: ac.otroCurso.id } });
    await agent.get(`/api/admin/subjects/${ajena.id}/groups`).expect(403);
    await agent.delete(`/api/admin/courses/${ac.otroCurso.id}`).expect(403); // faltaba comprobación de ámbito
  });

  it('RF-ACA-01: unicidad de código de asignatura → 409', async () => {
    const owner = await createUser({ academic: ac, role: Role.PROPIETARIO });
    const res = await (await webAgent(app, owner.email)).post('/api/admin/subjects').send({ cursoId: ac.curso.id, nombre: 'Dup', codigo: ac.asignatura.codigo });
    expect(res.status).toBe(409);
  });
});

describe('RS-06 / RS-10 Tickets y auditoría', () => {
  it('CA-11: un ticket CLOSED no admite mensajes (409)', async () => {
    const u = await createUser({ academic: ac });
    const agent = await webAgent(app, u.email);
    const t = await agent.post('/api/tickets').send({ asunto: 'Ayuda con el grupo', mensaje: 'Hola' }).expect(201);
    await agent.patch(`/api/tickets/${t.body.id}/close`).expect(200);
    await agent.post(`/api/tickets/${t.body.id}/messages`).send({ content: 'otro' }).expect(409);
  });

  it('CA-12: un embajador de ámbito A solo ve en el log acciones de usuarios de A', async () => {
    const otra = await seedAcademic();
    const emb = await embajador(ac);
    const enA = await createUser({ academic: ac });
    const enB = await createUser({ academic: otra });
    await prisma.log.createMany({
      data: [
        { userId: enA.id, action: 'CREATE_OFFER', payload: {} },
        { userId: enB.id, action: 'CREATE_OFFER', payload: {} },
      ],
    });
    const res = await (await webAgent(app, emb.email)).get('/api/admin/logs?actionFilter=CREATE_OFFER').expect(200);
    const userIds = res.body.logs.map((l: { userId: string }) => l.userId);
    expect(userIds).toContain(enA.id);
    expect(userIds).not.toContain(enB.id);
  });

  it('RF-LOG-06: el log no guarda contraseñas, OTP ni tokens', async () => {
    const u = await createUser({ academic: ac });
    await request(app).post('/api/auth/forgot-password').send({ email: u.email });
    const { lastOtpFor } = await import('../support/mailbox');
    await request(app).post('/api/auth/reset-password').send({ email: u.email, otpCode: lastOtpFor(u.email), newPassword: 'Nueva#2026' }).expect(200);
    await new Promise((r) => setTimeout(r, 100));
    const logs = JSON.stringify(await prisma.log.findMany());
    expect(logs).not.toContain('Nueva#2026');
    expect(logs).not.toContain(lastOtpFor(u.email));
  });

  it('RF-TGB-11 / matriz de roles: un estudiante no accede a /admin', async () => {
    const u = await createUser({ academic: ac });
    await (await webAgent(app, u.email)).get('/api/admin/logs').expect(403);
  });
});
