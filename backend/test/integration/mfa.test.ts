import request from 'supertest';
import { Role } from '@prisma/client';
import { prisma } from '../../src/config/prisma';
import { createApp } from '../../src/app';
import { fakeMfa } from '../support/integration-setup';
import { seedAcademic, createUser, webAgent, enableMfa, linkChannel, bot, eventCollector, Academic, PASSWORD } from '../support/factories';

const app = createApp();
let ac: Academic;
beforeEach(async () => {
  ac = await seedAcademic();
});

const sessionCookies = (res: request.Response) =>
  ((res.headers['set-cookie'] as unknown as string[] | undefined) ?? []).filter((c) => /^(access_token|refresh_token)=[^;]/.test(c));

describe('RS-15 activación (CA-13, RF-MFA-01..03)', () => {
  it('activar exige reautenticación previa (401 REAUTH_REQUIRED)', async () => {
    const u = await createUser({ academic: ac });
    const agent = await webAgent(app, u.email);
    const res = await agent.post('/api/v1/auth/mfa/enrollments');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('REAUTH_REQUIRED');
  });

  it('CA-13: escanea y confirma → MFA activo, 10 códigos de recuperación (no-store) y notificación', async () => {
    const events = eventCollector();
    await events.start();
    const u = await createUser({ academic: ac });
    const agent = await webAgent(app, u.email);
    await agent.post('/api/v1/auth/reauthenticate').send({ password: 'Mala#2026x' }).expect(401);
    await agent.post('/api/v1/auth/reauthenticate').send({ password: PASSWORD }).expect(200);

    const enr = await agent.post('/api/v1/auth/mfa/enrollments').expect(201);
    expect(enr.headers['cache-control']).toBe('no-store');
    expect(enr.body.provisioningUri).toMatch(/^xchanger-otp:\/\/v1\/enroll\?/);
    expect(enr.body.manualEntry).toMatchObject({ algorithm: 'SHA256', digits: 6, period: 30 });
    expect(enr.body.manualEntry.account).toMatch(/^.\*\*\*@alumnos\.unican\.es$/);
    expect(enr.body.manualEntry.secret).toMatch(/^([A-Z2-7]{4} )+[A-Z2-7]{1,4}$/);

    // Hasta confirmar, el factor está pendiente
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).mfaEnabled).toBe(false);
    const status = await agent.get('/api/v1/auth/mfa').expect(200);
    expect(status.body).toMatchObject({ enabled: false, pendingEnrollment: { enrollmentId: enr.body.enrollmentId } });

    await agent.post(`/api/v1/auth/mfa/enrollments/${enr.body.enrollmentId}/confirm`).send({ code: '000000' }).expect(401);
    const conf = await agent
      .post(`/api/v1/auth/mfa/enrollments/${enr.body.enrollmentId}/confirm`)
      .send({ code: fakeMfa.engine.nextCode(u.id) })
      .expect(200);
    expect(conf.body.enabled).toBe(true);
    expect(conf.body.recoveryCodes).toHaveLength(10);
    expect(conf.headers['cache-control']).toBe('no-store');
    expect(sessionCookies(conf)).toHaveLength(2); // rota la sesión

    const db = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(db.mfaEnabled).toBe(true);
    expect(db.mfaEnabledAt).not.toBeNull();
    await new Promise((r) => setTimeout(r, 100));
    expect(await prisma.log.count({ where: { userId: u.id, action: 'MFA_ENABLED' } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId: u.id, asunto: { contains: 'dos pasos activada' } } })).toBe(1);
    expect((await events.collect()).map((e) => e.type)).toContain('mfa.enabled');

    // Ya activo → 409
    await agent.post('/api/v1/auth/reauthenticate').send({ password: PASSWORD, code: fakeMfa.engine.nextCode(u.id) }).expect(200);
    const again = await agent.post('/api/v1/auth/mfa/enrollments');
    expect(again.body.code).toBe('MFA_ALREADY_ENABLED');
  });

  it('cancelar un enrolamiento pendiente (EP-C-23)', async () => {
    const u = await createUser({ academic: ac });
    const agent = await webAgent(app, u.email);
    await agent.post('/api/v1/auth/reauthenticate').send({ password: PASSWORD }).expect(200);
    const enr = await agent.post('/api/v1/auth/mfa/enrollments').expect(201);
    await agent.delete(`/api/v1/auth/mfa/enrollments/${enr.body.enrollmentId}`).expect(204);
    expect((await agent.get('/api/v1/auth/mfa').expect(200)).body.pendingEnrollment).toBeNull();
  });
});

describe('Login web con MFA (CA-14, CA-15, RF-MFA-04..06)', () => {
  it('CA-14: contraseña correcta → 200 mfaRequired, sin cookies de sesión', async () => {
    const u = await createUser({ academic: ac });
    await enableMfa(app, fakeMfa, u.id, u.email);
    const res = await request(app).post('/api/v1/auth/login').send({ email: u.email, password: PASSWORD }).expect(200);
    expect(res.body).toEqual({ mfaRequired: true, methods: ['xotp', 'recovery_code'], expiresIn: 300 });
    expect(sessionCookies(res)).toHaveLength(0);
    const chal = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('mfa_challenge='))!;
    expect(chal).toMatch(/HttpOnly/);
    expect(chal).toMatch(/SameSite=Strict/);
    expect(chal).toMatch(/Path=\/api\/v1\/auth\/mfa\/challenge/);
  });

  it('el segundo paso emite la sesión y la cookie de reto deja de valer', async () => {
    const u = await createUser({ academic: ac });
    await enableMfa(app, fakeMfa, u.id, u.email);
    fakeMfa.engine.advance(30_000);
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ email: u.email, password: PASSWORD }).expect(200);
    const ok = await agent.post('/api/auth/mfa/challenge').send({ code: fakeMfa.engine.nextCode(u.id) }).expect(200);
    expect(ok.body.user).toMatchObject({ id: u.id, email: u.email });
    expect(sessionCookies(ok)).toHaveLength(2);
    await agent.get('/api/auth/me').expect(200);
    const again = await agent.post('/api/auth/mfa/challenge').send({ code: '123456' });
    expect(again.status).toBe(410);
  });

  it('CA-15: un código ya usado se rechaza (401 MFA_INVALID_CODE, reason REPLAYED)', async () => {
    const u = await createUser({ academic: ac });
    await enableMfa(app, fakeMfa, u.id, u.email);
    fakeMfa.engine.advance(30_000);
    const code = fakeMfa.engine.nextCode(u.id);
    const a1 = request.agent(app);
    await a1.post('/api/auth/login').send({ email: u.email, password: PASSWORD });
    await a1.post('/api/auth/mfa/challenge').send({ code }).expect(200);
    const a2 = request.agent(app);
    await a2.post('/api/auth/login').send({ email: u.email, password: PASSWORD });
    const replay = await a2.post('/api/auth/mfa/challenge').send({ code });
    expect(replay.status).toBe(401);
    expect(replay.body).toMatchObject({ code: 'MFA_INVALID_CODE', details: { reason: 'REPLAYED' } });
  });

  it('cada reto admite como máximo 5 intentos; después hay que repetir el primer factor', async () => {
    const u = await createUser({ academic: ac });
    await enableMfa(app, fakeMfa, u.id, u.email);
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ email: u.email, password: PASSWORD });
    const remaining: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await agent.post('/api/auth/mfa/challenge').send({ code: '000000' });
      expect(r.status).toBe(401);
      remaining.push(r.body.details.remainingAttempts);
    }
    expect(remaining).toEqual([4, 3, 2, 1]);
    // El 5.º fallo agota el reto y el factor queda bloqueado 15 min (RF-MFA-06)
    const fifth = await agent.post('/api/auth/mfa/challenge').send({ code: '000000' });
    expect(fifth.body.details.remainingAttempts).toBe(0);
    const after = await agent.post('/api/auth/mfa/challenge').send({ code: fakeMfa.engine.nextCode(u.id) });
    expect(after.status).toBe(410);
    expect(after.body.code).toBe('MFA_CHALLENGE_EXPIRED');
    const relogin = request.agent(app);
    await relogin.post('/api/auth/login').send({ email: u.email, password: PASSWORD });
    const locked = await relogin.post('/api/auth/mfa/challenge').send({ code: fakeMfa.engine.nextCode(u.id) });
    expect(locked.status).toBe(423);
    expect(locked.body.code).toBe('MFA_LOCKED');
    expect(locked.body.details.retryAfter).toBeGreaterThan(0);
  });

  it('un código de recuperación sirve una vez, se registra y se notifica (RF-MFA-10)', async () => {
    const u = await createUser({ academic: ac });
    const { recoveryCodes } = await enableMfa(app, fakeMfa, u.id, u.email);
    const login = async () => {
      const a = request.agent(app);
      await a.post('/api/auth/login').send({ email: u.email, password: PASSWORD });
      return a;
    };
    await (await login()).post('/api/auth/mfa/challenge').send({ recoveryCode: recoveryCodes[0].toLowerCase() }).expect(200);
    const reuse = await (await login()).post('/api/auth/mfa/challenge').send({ recoveryCode: recoveryCodes[0] });
    expect(reuse.status).toBe(401);
    await new Promise((r) => setTimeout(r, 100));
    expect(await prisma.log.count({ where: { userId: u.id, action: 'MFA_RECOVERY_USED' } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId: u.id, asunto: { contains: 'recuperación' } } })).toBe(1);
    // code y recoveryCode son excluyentes
    expect((await (await login()).post('/api/auth/mfa/challenge').send({ code: '123456', recoveryCode: recoveryCodes[1] })).status).toBe(400);
  });

  it('el bloqueo solo se revela tras ambos factores (§7.3)', async () => {
    const u = await createUser({ academic: ac });
    await enableMfa(app, fakeMfa, u.id, u.email);
    await prisma.user.update({ where: { id: u.id }, data: { role: 'BLOQUEADO', blockReason: 'abuso' } });
    fakeMfa.engine.advance(30_000);
    const agent = request.agent(app);
    const r1 = await agent.post('/api/auth/login').send({ email: u.email, password: PASSWORD });
    expect(r1.body.mfaRequired).toBe(true);
    const r2 = await agent.post('/api/auth/mfa/challenge').send({ code: fakeMfa.engine.nextCode(u.id) });
    expect(r2.status).toBe(403);
    expect(r2.body.code).toBe('ACCOUNT_BLOCKED');
  });

  it('CA-17: mfa-service caído → 503 para usuarios con MFA; los demás entran con normalidad', async () => {
    const withMfa = await createUser({ academic: ac });
    const without = await createUser({ academic: ac });
    await enableMfa(app, fakeMfa, withMfa.id, withMfa.email);
    fakeMfa.engine.down = true;
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ email: withMfa.email, password: PASSWORD }).expect(200);
    const res = await agent.post('/api/auth/mfa/challenge').send({ code: '123456' });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('MFA_SERVICE_UNAVAILABLE');
    await request(app).post('/api/auth/login').send({ email: without.email, password: PASSWORD }).expect(200);
    // Estado MFA de un usuario sin MFA se degrada sin error
    const st = await (await webAgent(app, without.email)).get('/api/v1/auth/mfa').expect(200);
    expect(st.body).toMatchObject({ enabled: false, degraded: true });
  });

  it('RF-MFA-11: recuperar la contraseña no desactiva el MFA', async () => {
    const u = await createUser({ academic: ac });
    await enableMfa(app, fakeMfa, u.id, u.email);
    await request(app).post('/api/auth/forgot-password').send({ email: u.email });
    const { lastOtpFor } = await import('../support/mailbox');
    await request(app).post('/api/auth/reset-password').send({ email: u.email, otpCode: lastOtpFor(u.email), newPassword: 'Nueva#2026' }).expect(200);
    const r = await request(app).post('/api/auth/login').send({ email: u.email, password: 'Nueva#2026' }).expect(200);
    expect(r.body.mfaRequired).toBe(true);
  });
});

describe('Gestión del factor (RF-MFA-07..09)', () => {
  it('desactivar exige contraseña y código; borra el factor y notifica', async () => {
    const u = await createUser({ academic: ac });
    const { agent } = await enableMfa(app, fakeMfa, u.id, u.email);
    fakeMfa.engine.advance(30_000);
    await agent.post('/api/v1/auth/mfa/disable').send({ password: 'Mala#2026x', code: fakeMfa.engine.nextCode(u.id) }).expect(401);
    await agent.post('/api/v1/auth/mfa/disable').send({ password: PASSWORD }).expect(400);
    await agent.post('/api/v1/auth/mfa/disable').send({ password: PASSWORD, code: fakeMfa.engine.nextCode(u.id) }).expect(204);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).mfaEnabled).toBe(false);
    expect(fakeMfa.engine.factors.has(u.id)).toBe(false);
    await agent.post('/api/v1/auth/mfa/disable').send({ password: PASSWORD, code: '123456' }).expect(409);
  });

  it('regenerar los códigos de recuperación anula los anteriores', async () => {
    const u = await createUser({ academic: ac });
    const { agent, recoveryCodes } = await enableMfa(app, fakeMfa, u.id, u.email);
    fakeMfa.engine.advance(30_000);
    const res = await agent.post('/api/v1/auth/mfa/recovery-codes').send({ code: fakeMfa.engine.nextCode(u.id) }).expect(200);
    expect(res.body.recoveryCodes).toHaveLength(10);
    expect(res.body.recoveryCodes).not.toContain(recoveryCodes[0]);
    const login = request.agent(app);
    await login.post('/api/auth/login').send({ email: u.email, password: PASSWORD });
    expect((await login.post('/api/auth/mfa/challenge').send({ recoveryCode: recoveryCodes[0] })).status).toBe(401);
  });

  it('RF-MFA-09: un administrador con ámbito restablece el MFA con motivo y revoca sesiones', async () => {
    const otra = await seedAcademic();
    const emb = await createUser({ academic: ac, role: Role.EMBAJADOR });
    await prisma.adminScope.create({ data: { userId: emb.id, carreraId: ac.carrera.id } });
    const u = await createUser({ academic: ac });
    const ajeno = await createUser({ academic: otra });
    await enableMfa(app, fakeMfa, u.id, u.email);
    const { svc, accessToken } = await (async () => {
      // La sesión de canal se abre con el usuario ya con MFA (vinculación vía web completa)
      await prisma.user.update({ where: { id: u.id }, data: { mfaEnabled: false } });
      const s = await linkChannel(app, u.email);
      await prisma.user.update({ where: { id: u.id }, data: { mfaEnabled: true } });
      return s;
    })();
    const embAgent = await webAgent(app, emb.email);
    await embAgent.post(`/api/admin/users/${u.id}/mfa/reset`).send({ reason: 'corto' }).expect(400);
    await embAgent.post(`/api/admin/users/${ajeno.id}/mfa/reset`).send({ reason: 'perdió el móvil, verificado en persona' }).expect(403);
    await embAgent.post(`/api/admin/users/${u.id}/mfa/reset`).send({ reason: 'perdió el móvil, verificado en persona' }).expect(204);
    const db = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(db.mfaEnabled).toBe(false);
    expect(db.refreshTokenHash).toBeNull();
    await bot(app, svc, accessToken).get('/api/v1/offers/me').expect(401);
    await new Promise((r) => setTimeout(r, 100));
    const log = await prisma.log.findFirstOrThrow({ where: { action: 'MFA_RESET' } });
    expect(log.payload).toMatchObject({ targetId: u.id, reason: 'perdió el móvil, verificado en persona' });
    await embAgent.post(`/api/admin/users/${u.id}/mfa/reset`).send({ reason: 'perdió el móvil, verificado en persona' }).expect(409);
  });

  it('EP-C-20: el bot puede leer el estado MFA, pero no gestionarlo', async () => {
    const u = await createUser({ academic: ac });
    const { svc, accessToken } = await linkChannel(app, u.email);
    const st = await bot(app, svc, accessToken).get('/api/v1/auth/mfa').expect(200);
    expect(st.body).toMatchObject({ enabled: false, method: null });
    const enr = await bot(app, svc, accessToken).post('/api/v1/auth/mfa/enrollments');
    expect(enr.body.code).toBe('CHANNEL_FORBIDDEN_ROUTE');
  });
});
