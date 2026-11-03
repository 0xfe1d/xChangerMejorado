import request from 'supertest';
import { prisma } from '../../src/config/prisma';
import { createApp } from '../../src/app';
import { mailbox, lastOtpFor } from '../support/mailbox';
import { seedAcademic, createUser, webAgent, PASSWORD, Academic } from '../support/factories';

const app = createApp();
let ac: Academic;
beforeEach(async () => {
  ac = await seedAcademic();
});

const newEmail = () => `nuevo${Date.now()}@alumnos.unican.es`;

describe('RS-01 Registro con OTP (regresión)', () => {
  it('CA-01: un correo @gmail.com devuelve 400 y no crea registro pendiente', async () => {
    const res = await request(app).post('/api/auth/register').send({
      email: 'x@gmail.com', name: 'Ana', password: PASSWORD, carreraId: ac.carrera.id, cursoId: ac.curso.id,
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_EMAIL_DOMAIN');
    expect(await prisma.pendingRegistration.count()).toBe(0);
  });

  it('RF-AUT-02/03: email duplicado → 409; contraseña débil → 400', async () => {
    const u = await createUser({ academic: ac });
    const dup = await request(app).post('/api/auth/register').send({ email: u.email, name: 'Ana', password: PASSWORD, carreraId: ac.carrera.id, cursoId: ac.curso.id });
    expect(dup.status).toBe(409);
    const weak = await request(app).post('/api/auth/register').send({ email: newEmail(), name: 'Ana', password: 'debilpass', carreraId: ac.carrera.id, cursoId: ac.curso.id });
    expect(weak.status).toBe(400);
  });

  it('CA-02: OTP correcto antes de 30 min crea la cuenta (rol Estudiante) e inicia sesión', async () => {
    const agent = request.agent(app);
    const email = newEmail();
    const r1 = await agent.post('/api/auth/register').send({ email, name: 'Ana Pérez', password: PASSWORD, carreraId: ac.carrera.id, cursoId: ac.curso.id });
    expect(r1.status).toBe(202);
    const pending = await prisma.pendingRegistration.findUniqueOrThrow({ where: { email } });
    expect(pending.otpCodeHash).not.toBe(lastOtpFor(email)); // se guarda hash, no el código
    const r2 = await agent.post('/api/auth/verify-otp').send({ otpCode: lastOtpFor(email) });
    expect(r2.status).toBe(201);
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.role).toBe('ESTUDIANTE');
    expect(await prisma.pendingRegistration.count()).toBe(0);
    const me = await agent.get('/api/auth/me').expect(200);
    expect(me.body).toMatchObject({ email, mfaEnabled: false });
  });

  it('CA-03: OTP tras 30 min → 410 y hay que repetir el registro', async () => {
    const agent = request.agent(app);
    const email = newEmail();
    await agent.post('/api/auth/register').send({ email, name: 'Ana', password: PASSWORD, carreraId: ac.carrera.id, cursoId: ac.curso.id });
    await prisma.pendingRegistration.update({ where: { email }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await agent.post('/api/auth/verify-otp').send({ otpCode: lastOtpFor(email) });
    expect(res.status).toBe(410);
    expect(await prisma.user.count({ where: { email } })).toBe(0);
  });

  it('el OTP de alta admite como máximo 5 intentos', async () => {
    const agent = request.agent(app);
    const email = newEmail();
    await agent.post('/api/auth/register').send({ email, name: 'Ana', password: PASSWORD, carreraId: ac.carrera.id, cursoId: ac.curso.id });
    const wrong = lastOtpFor(email) === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) expect((await agent.post('/api/auth/verify-otp').send({ otpCode: wrong })).status).toBe(400);
    expect((await agent.post('/api/auth/verify-otp').send({ otpCode: lastOtpFor(email) })).status).toBe(410);
  });
});

describe('RS-01 Login, refresco y cierre (regresión)', () => {
  it('RF-AUT-09: misma respuesta genérica si el email no existe o la contraseña es errónea', async () => {
    const u = await createUser({ academic: ac });
    const a = await request(app).post('/api/auth/login').send({ email: 'nadie@alumnos.unican.es', password: PASSWORD });
    const b = await request(app).post('/api/auth/login').send({ email: u.email, password: 'Otra#2026x' });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.error).toBe(b.body.error);
    expect(a.body.code).toBe(b.body.code);
  });

  it('una cuenta sin contraseña (creada por canal) recibe el mismo 401 genérico', async () => {
    const u = await createUser({ academic: ac, password: null });
    const res = await request(app).post('/api/auth/login').send({ email: u.email, password: PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_CREDENTIALS');
  });

  it('RF-AUT-10: cuenta bloqueada con credenciales correctas → 403 con motivo y fecha', async () => {
    const until = new Date(Date.now() + 86400_000);
    const u = await createUser({ academic: ac });
    await prisma.user.update({ where: { id: u.id }, data: { role: 'BLOQUEADO', blockedUntil: until, blockReason: 'spam' } });
    const res = await request(app).post('/api/auth/login').send({ email: u.email, password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ACCOUNT_BLOCKED');
    expect(res.body.detail).toMatchObject({ blocked: true, permanent: false, reason: 'spam', blockedUntil: until.toISOString() });
  });

  it('RF-AUT-11/12: cookies HttpOnly; refresh solo en su ruta y almacenado con hash', async () => {
    const u = await createUser({ academic: ac });
    const res = await request(app).post('/api/auth/login').send({ email: u.email, password: PASSWORD });
    const cookies = res.headers['set-cookie'] as unknown as string[];
    const access = cookies.find((c) => c.startsWith('access_token='))!;
    const refresh = cookies.find((c) => c.startsWith('refresh_token='))!;
    expect(access).toMatch(/HttpOnly/);
    expect(refresh).toMatch(/Path=\/api\/auth\/refresh/);
    const db = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(db.refreshTokenHash).toMatch(/^\$2[aby]\$/);
  });

  it('renueva el access token; tras logout el refresh deja de servir', async () => {
    const u = await createUser({ academic: ac });
    const agent = await webAgent(app, u.email);
    await agent.post('/api/auth/refresh').expect(200);
    await agent.post('/api/auth/logout').expect(200);
    const db = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(db.refreshTokenHash).toBeNull();
  });

  it('el refresco de un usuario bloqueado se deniega y revoca', async () => {
    const u = await createUser({ academic: ac });
    const agent = await webAgent(app, u.email);
    await prisma.user.update({ where: { id: u.id }, data: { role: 'BLOQUEADO' } });
    const res = await agent.post('/api/auth/refresh');
    expect(res.status).toBe(403);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).refreshTokenHash).toBeNull();
  });

  it('RF-AUT-17: registra LoginHistory con IP y agente', async () => {
    const u = await createUser({ academic: ac });
    await request(app).post('/api/auth/login').set('User-Agent', 'jest').send({ email: u.email, password: PASSWORD }).expect(200);
    await new Promise((r) => setTimeout(r, 100));
    const h = await prisma.loginHistory.findFirstOrThrow({ where: { userId: u.id } });
    expect(h.userAgent).toBe('jest');
  });

  it('RNF-03: el login se limita por cuenta (429 con retryAfter)', async () => {
    const u = await createUser({ academic: ac });
    let last;
    for (let i = 0; i < 11; i++) last = await request(app).post('/api/auth/login').send({ email: u.email, password: 'Mala#2026x' });
    expect(last!.status).toBe(429);
    expect(last!.body.code).toBe('RATE_LIMITED');
    expect(last!.body.details.retryAfter).toBeGreaterThan(0);
  });
});

describe('Recuperación y cambio de contraseña (regresión)', () => {
  it('RF-AUT-14: responde igual exista o no el email', async () => {
    const u = await createUser({ academic: ac });
    const a = await request(app).post('/api/auth/forgot-password').send({ email: u.email });
    const b = await request(app).post('/api/auth/forgot-password').send({ email: 'nadie@alumnos.unican.es' });
    expect(a.status).toBe(200);
    expect(b.body).toEqual(a.body);
    expect(mailbox.filter((m) => m.otp)).toHaveLength(1);
  });

  it('RF-AUT-15: el restablecimiento revoca sesiones y registra PASSWORD_RESET; sirve para fijar contraseña (ADR-29)', async () => {
    const u = await createUser({ academic: ac, password: null });
    await request(app).post('/api/auth/forgot-password').send({ email: u.email });
    await request(app).post('/api/auth/reset-password').send({ email: u.email, otpCode: lastOtpFor(u.email), newPassword: 'Nueva#2026' }).expect(200);
    await request(app).post('/api/auth/login').send({ email: u.email, password: 'Nueva#2026' }).expect(200);
    await new Promise((r) => setTimeout(r, 100));
    expect(await prisma.log.count({ where: { userId: u.id, action: 'PASSWORD_RESET' } })).toBe(1);
  });

  it('RF-AUT-16: cambiar contraseña exige la actual', async () => {
    const u = await createUser({ academic: ac });
    const agent = await webAgent(app, u.email);
    await agent.patch('/api/auth/settings/password').send({ currentPassword: 'Mala#2026x', newPassword: 'Nueva#2026' }).expect(401);
    await agent.patch('/api/auth/settings/password').send({ currentPassword: PASSWORD, newPassword: 'Nueva#2026' }).expect(204);
  });

  it('RF-PER-01: el email no es modificable desde Ajustes', async () => {
    const u = await createUser({ academic: ac });
    const agent = await webAgent(app, u.email);
    await agent.patch('/api/auth/me').send({ email: 'otro@alumnos.unican.es' }).expect(400);
    const ok = await agent.patch('/api/auth/me').send({ name: 'Nombre Nuevo' }).expect(200);
    expect(ok.body).toMatchObject({ name: 'Nombre Nuevo', email: u.email });
  });
});

describe('Versionado (§5.6)', () => {
  it('/api es alias de /api/v1', async () => {
    const u = await createUser({ academic: ac });
    const agent = await webAgent(app, u.email);
    const a = await agent.get('/api/auth/me').expect(200);
    const b = await agent.get('/api/v1/auth/me').expect(200);
    expect(a.body).toEqual(b.body);
  });

  it('RF-ACA-08: el catálogo de registro es público', async () => {
    const res = await request(app).get('/api/v1/public/careers').expect(200);
    expect(res.body.map((c: { id: string }) => c.id)).toContain(ac.carrera.id);
    await request(app).get(`/api/v1/public/careers/${ac.carrera.id}/courses`).expect(200);
  });

  it('GET /health devuelve estado y marca de tiempo (RNF-10, EP-C-30)', async () => {
    const res = await request(app).get('/health').expect(200);
    expect(res.body.status).toBe('ok');
    expect(new Date(res.body.timestamp).getTime()).not.toBeNaN();
    const deep = await request(app).get('/api/v1/health?deep=true').expect(200);
    expect(deep.body.dependencies).toMatchObject({ db: 'up', redis: 'up', mfa: 'up' });
  });
});
