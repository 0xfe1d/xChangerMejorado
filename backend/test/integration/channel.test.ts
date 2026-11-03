import request from 'supertest';
import jwt from 'jsonwebtoken';
import { Role } from '@prisma/client';
import { prisma } from '../../src/config/prisma';
import { createApp } from '../../src/app';
import { lastOtpFor, mailbox } from '../support/mailbox';
import { fakeMfa } from '../support/integration-setup';
import {
  seedAcademic, createUser, webAgent, serviceToken, linkChannel, bot, enableMfa, eventCollector, Academic, PASSWORD, BOT_SECRET,
} from '../support/factories';

const app = createApp();
let ac: Academic;
beforeEach(async () => {
  ac = await seedAcademic();
});

const svcHeader = (t: string) => ({ 'X-Service-Authorization': `Bearer ${t}` });

describe('EP-C-01 / EP-C-02 autenticación de servicio', () => {
  it('canjea client credentials por un JWT de servicio y publica el JWKS interno', async () => {
    const res = await request(app).post('/api/v1/service-auth/token')
      .send({ grant_type: 'client_credentials', client_id: 'telegram-bot', client_secret: BOT_SECRET }).expect(200);
    expect(res.body).toMatchObject({ token_type: 'Bearer', expires_in: 600, scope: 'channel:telegram' });
    expect(res.headers['cache-control']).toBe('no-store');
    const jwks = await request(app).get('/api/v1/internal/.well-known/jwks.json').expect(200);
    expect(jwks.body.keys[0]).toMatchObject({ kty: 'EC', alg: 'ES256' });
  });

  it('rechaza credenciales incorrectas (401 SERVICE_UNAUTHORIZED) y scopes ajenos (400 INVALID_SCOPE)', async () => {
    const bad = await request(app).post('/api/v1/service-auth/token')
      .send({ grant_type: 'client_credentials', client_id: 'telegram-bot', client_secret: 'x'.repeat(40) });
    expect(bad.status).toBe(401);
    expect(bad.body.code).toBe('SERVICE_UNAUTHORIZED');
    const scope = await request(app).post('/api/v1/service-auth/token')
      .send({ grant_type: 'client_credentials', client_id: 'telegram-bot', client_secret: BOT_SECRET, scope: 'mfa:manage' });
    expect(scope.body.code).toBe('INVALID_SCOPE');
  });

  it('los endpoints S exigen credencial de servicio', async () => {
    const res = await request(app).post('/api/v1/channel-auth/link-requests').send({ channel: 'telegram', externalUserId: '1', displayName: 'x' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('SERVICE_UNAUTHORIZED');
  });
});

describe('CA-18 vinculación por autorización de dispositivo (EP-C-03..06)', () => {
  it('flujo completo: código → aprobación web → canje → /misofertas funciona', async () => {
    const events = eventCollector();
    await events.start();
    const u = await createUser({ academic: ac, name: 'Ana P.' });
    const svc = await serviceToken(app);

    const lr = await request(app).post('/api/v1/channel-auth/link-requests').set(svcHeader(svc))
      .send({ channel: 'telegram', externalUserId: '424242', displayName: 'Ana TG', username: 'ana_tg' }).expect(201);
    expect(lr.body).toMatchObject({ expiresIn: 600, interval: 5 });
    expect(lr.body.userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(lr.body.deviceCode).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(lr.body.verificationUriComplete).toContain(encodeURIComponent(lr.body.userCode));

    // Mientras no se aprueba: AUTHORIZATION_PENDING (y SLOW_DOWN si sondea demasiado rápido)
    const tokenBody = { grant_type: 'link_code', channel: 'telegram', externalUserId: '424242', deviceCode: lr.body.deviceCode };
    const p1 = await request(app).post('/api/v1/channel-auth/token').set(svcHeader(svc)).send(tokenBody);
    expect(p1.body.code).toBe('AUTHORIZATION_PENDING');
    const p2 = await request(app).post('/api/v1/channel-auth/token').set(svcHeader(svc)).send(tokenBody);
    expect(p2.body.code).toBe('SLOW_DOWN');

    const web = await webAgent(app, u.email);
    const shown = await web.get(`/api/v1/channel-links/${lr.body.userCode.toLowerCase()}`).expect(200);
    expect(shown.body).toMatchObject({ channel: 'telegram', displayName: 'Ana TG', status: 'PENDING' });
    await web.post(`/api/v1/channel-links/${lr.body.userCode}/decision`).send({ decision: 'approve' }).expect(200, { status: 'APPROVED' });

    const tok = await request(app).post('/api/v1/channel-auth/token').set(svcHeader(svc)).send(tokenBody).expect(200);
    expect(tok.body).toMatchObject({
      accessTokenExpiresIn: 900,
      user: { id: u.id, name: 'Ana P.', role: 'ESTUDIANTE', mfaEnabled: false, hasExpediente: true },
    });
    expect(tok.body.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // El deviceCode es de un solo uso
    const again = await request(app).post('/api/v1/channel-auth/token').set(svcHeader(svc)).send(tokenBody);
    expect(again.body.code).toBe('INVALID_GRANT');

    const mine = await bot(app, svc, tok.body.accessToken).get('/api/v1/offers/me').expect(200);
    expect(mine.body).toEqual({ items: [], nextCursor: null });

    const seen = await events.collect();
    expect(seen.map((e) => e.type)).toContain('channel.link.approved');
    await new Promise((r) => setTimeout(r, 100));
    expect(await prisma.log.count({ where: { userId: u.id, action: 'CHANNEL_LINKED' } })).toBe(1);
    // AR-16: aviso de vinculación al usuario
    expect(await prisma.notification.count({ where: { userId: u.id, asunto: { contains: 'Telegram' } } })).toBeGreaterThan(0);
  });

  it('rechazar la vinculación → ACCESS_DENIED al canjear', async () => {
    const u = await createUser({ academic: ac });
    const svc = await serviceToken(app);
    const lr = await request(app).post('/api/v1/channel-auth/link-requests').set(svcHeader(svc))
      .send({ channel: 'telegram', externalUserId: '7', displayName: 'X' }).expect(201);
    await (await webAgent(app, u.email)).post(`/api/v1/channel-links/${lr.body.userCode}/decision`).send({ decision: 'deny' }).expect(200, { status: 'DENIED' });
    const res = await request(app).post('/api/v1/channel-auth/token').set(svcHeader(svc))
      .send({ grant_type: 'link_code', channel: 'telegram', externalUserId: '7', deviceCode: lr.body.deviceCode });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ACCESS_DENIED');
  });

  it('aprobar exige sesión web reciente (login de más de 15 min → 401 REAUTH_REQUIRED)', async () => {
    const u = await createUser({ academic: ac });
    const svc = await serviceToken(app);
    const lr = await request(app).post('/api/v1/channel-auth/link-requests').set(svcHeader(svc))
      .send({ channel: 'telegram', externalUserId: '8', displayName: 'X' }).expect(201);
    const stale = jwt.sign(
      { sub: u.id, email: u.email, role: 'ESTUDIANTE', jti: 'x', auth_time: Math.floor(Date.now() / 1000) - 20 * 60 },
      process.env.JWT_ACCESS_SECRET!, { expiresIn: '5m' },
    );
    const res = await request(app).post(`/api/v1/channel-links/${lr.body.userCode}/decision`).set('Cookie', `access_token=${stale}`).send({ decision: 'approve' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('REAUTH_REQUIRED');
  });

  it('una identidad de Telegram vinculada a otra cuenta → 409 CHANNEL_IDENTITY_TAKEN', async () => {
    const a = await createUser({ academic: ac });
    const b = await createUser({ academic: ac });
    await linkChannel(app, a.email, '999');
    const svc = await serviceToken(app);
    const lr = await request(app).post('/api/v1/channel-auth/link-requests').set(svcHeader(svc))
      .send({ channel: 'telegram', externalUserId: '999', displayName: 'X' }).expect(201);
    const res = await (await webAgent(app, b.email)).post(`/api/v1/channel-links/${lr.body.userCode}/decision`).send({ decision: 'approve' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CHANNEL_IDENTITY_TAKEN');
  });

  it('una solicitud caducada → 410 LINK_EXPIRED', async () => {
    const u = await createUser({ academic: ac });
    const svc = await serviceToken(app);
    const lr = await request(app).post('/api/v1/channel-auth/link-requests').set(svcHeader(svc))
      .send({ channel: 'telegram', externalUserId: '11', displayName: 'X' }).expect(201);
    await prisma.channelLinkRequest.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await (await webAgent(app, u.email)).get(`/api/v1/channel-links/${lr.body.userCode}`);
    expect(res.status).toBe(410);
    expect(res.body.code).toBe('LINK_EXPIRED');
  });

  it('límite de 5 solicitudes por externalUserId y hora', async () => {
    const svc = await serviceToken(app);
    const send = () => request(app).post('/api/v1/channel-auth/link-requests').set(svcHeader(svc))
      .send({ channel: 'telegram', externalUserId: '55', displayName: 'X' });
    for (let i = 0; i < 5; i++) expect((await send()).status).toBe(201);
    expect((await send()).status).toBe(429);
  });
});

describe('Sesión de canal: extractor y política (§5.2, §5.5)', () => {
  it('CA-21: el token de canal sin credencial de servicio → 401; en /admin → 403 CHANNEL_FORBIDDEN_ROUTE', async () => {
    const owner = await createUser({ academic: ac, role: Role.PROPIETARIO });
    const { svc, accessToken } = await linkChannel(app, owner.email);
    const noSvc = await request(app).get('/api/v1/offers/me').set('Authorization', `Bearer ${accessToken}`);
    expect(noSvc.status).toBe(401);
    const admin = await bot(app, svc, accessToken).get('/api/v1/admin/logs');
    expect(admin.status).toBe(403);
    expect(admin.body.code).toBe('CHANNEL_FORBIDDEN_ROUTE');
    // También rutas no marcadas (por defecto solo web): detalle de oferta, tickets, ajustes
    expect((await bot(app, svc, accessToken).get('/api/v1/tickets/me')).body.code).toBe('CHANNEL_FORBIDDEN_ROUTE');
    expect((await bot(app, svc, accessToken).patch('/api/v1/auth/settings/password')).body.code).toBe('CHANNEL_FORBIDDEN_ROUTE');
  });

  it('la credencial de servicio sola no basta (sin Bearer de canal → 401)', async () => {
    const svc = await serviceToken(app);
    const res = await request(app).get('/api/v1/offers/me').set(svcHeader(svc));
    expect(res.status).toBe(401);
  });

  it('cookie y cabecera de servicio a la vez → 400 AMBIGUOUS_CREDENTIALS', async () => {
    const u = await createUser({ academic: ac });
    const { svc, accessToken } = await linkChannel(app, u.email);
    const res = await bot(app, svc, accessToken).get('/api/v1/offers/me').set('Cookie', 'access_token=cualquiera');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('AMBIGUOUS_CREDENTIALS');
  });

  it('el bot reutiliza expediente, catálogo, búsqueda, oferta y aceptación (RF-TGB-04..06)', async () => {
    const a = await createUser({ academic: ac });
    const b = await createUser({ academic: ac, expediente: false });
    const { svc, accessToken } = await linkChannel(app, b.email);
    const tg = bot(app, svc, accessToken);
    await tg.get('/api/v1/me/expediente').expect(200, []);
    await tg.post('/api/v1/me/expediente').set('Idempotency-Key', 'tg:1').send({ asignaturaId: ac.asignatura.id }).expect(201);
    await tg.post('/api/v1/me/expediente').set('Idempotency-Key', 'tg:2').send({ asignaturaId: ac.asignatura.id }).expect(200);
    const groups = await tg.get(`/api/v1/subjects/${ac.asignatura.id}/groups`).expect(200);
    expect(groups.body).toHaveLength(3);
    const offerA = await (await webAgent(app, a.email)).post('/api/offers').send({ asignaturaId: ac.asignatura.id, grupoActualId: ac.g1.id, grupoDeseadoId: ac.g2.id }).expect(201);
    const search = await tg.get(`/api/v1/offers?asignaturaId=${ac.asignatura.id}&grupoActualId=${ac.g2.id}&grupoDeseadoId=${ac.g1.id}`).expect(200);
    expect(search.body.items.map((o: { id: string }) => o.id)).toEqual([offerA.body.id]); // canal: formato paginado por defecto
    await tg.post(`/api/v1/offers/${offerA.body.id}/accept`).set('Idempotency-Key', 'tg:3').expect(200);
    await tg.post(`/api/v1/offers/${offerA.body.id}/messages`).set('Idempotency-Key', 'tg:4').send({ content: 'hola desde Telegram' }).expect(201);
    await tg.patch(`/api/v1/offers/${offerA.body.id}/close`).expect(200);
    const me = await tg.get('/api/v1/auth/me').expect(200);
    expect(me.body).toMatchObject({ id: b.id, mfaEnabled: false });
  });
});

describe('CA-19 idempotencia (§5.6, EP-C-29)', () => {
  it('Telegram reintenta el mismo update: una sola oferta y la misma respuesta', async () => {
    const u = await createUser({ academic: ac });
    const { svc, accessToken } = await linkChannel(app, u.email);
    const body = { asignaturaId: ac.asignatura.id, grupoActualId: ac.g1.id, grupoDeseadoId: ac.g2.id };
    const r1 = await bot(app, svc, accessToken).post('/api/v1/offers').set('Idempotency-Key', 'tg:777').send(body).expect(201);
    const r2 = await bot(app, svc, accessToken).post('/api/v1/offers').set('Idempotency-Key', 'tg:777').send(body).expect(201);
    expect(r2.body.id).toBe(r1.body.id);
    expect(r2.headers['idempotent-replayed']).toBe('true');
    expect(await prisma.offer.count()).toBe(1);
  });

  it('misma clave con otro cuerpo → 422 IDEMPOTENCY_CONFLICT; sin clave desde canal → 400', async () => {
    const u = await createUser({ academic: ac });
    const { svc, accessToken } = await linkChannel(app, u.email);
    const tg = bot(app, svc, accessToken);
    await tg.post('/api/v1/offers').set('Idempotency-Key', 'tg:1').send({ asignaturaId: ac.asignatura.id, grupoActualId: ac.g1.id, grupoDeseadoId: ac.g2.id }).expect(201);
    const conflict = await tg.post('/api/v1/offers').set('Idempotency-Key', 'tg:1').send({ asignaturaId: ac.asignatura.id, grupoActualId: ac.g1.id, grupoDeseadoId: ac.g3.id });
    expect(conflict.status).toBe(422);
    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');
    const missing = await tg.post('/api/v1/offers').send({ asignaturaId: ac.asignatura.id, grupoActualId: ac.g2.id, grupoDeseadoId: ac.g3.id });
    expect(missing.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('en la web la cabecera es opcional (contrato actual intacto)', async () => {
    const u = await createUser({ academic: ac });
    await (await webAgent(app, u.email)).post('/api/offers').send({ asignaturaId: ac.asignatura.id, grupoActualId: ac.g1.id, grupoDeseadoId: ac.g2.id }).expect(201);
  });
});

describe('Refresco y revocación de sesiones de canal (ADR-18)', () => {
  it('rota el refresh token; reutilizar el anterior revoca toda la familia', async () => {
    const events = eventCollector();
    await events.start();
    const u = await createUser({ academic: ac });
    const { svc, externalUserId, refreshToken } = await linkChannel(app, u.email);
    const body = (rt: string) => ({ grant_type: 'refresh_token', channel: 'telegram', externalUserId, refreshToken: rt });
    const r1 = await request(app).post('/api/v1/channel-auth/token').set(svcHeader(svc)).send(body(refreshToken)).expect(200);
    expect(r1.body.refreshToken).not.toBe(refreshToken);
    const reuse = await request(app).post('/api/v1/channel-auth/token').set(svcHeader(svc)).send(body(refreshToken));
    expect(reuse.body.code).toBe('INVALID_GRANT');
    // El token nuevo también muere: familia revocada
    const after = await request(app).post('/api/v1/channel-auth/token').set(svcHeader(svc)).send(body(r1.body.refreshToken));
    expect(after.body.code).toBe('INVALID_GRANT');
    await bot(app, svc, r1.body.accessToken).get('/api/v1/offers/me').expect(401);
    const revoked = (await events.collect()).filter((e) => e.type === 'channel.session.revoked');
    expect(revoked.some((e) => (e.data as { reason: string }).reason === 'REUSE_DETECTED')).toBe(true);
  });

  it('un refresh de otra identidad externa → INVALID_GRANT', async () => {
    const u = await createUser({ academic: ac });
    const { svc, refreshToken } = await linkChannel(app, u.email);
    const res = await request(app).post('/api/v1/channel-auth/token').set(svcHeader(svc))
      .send({ grant_type: 'refresh_token', channel: 'telegram', externalUserId: '1', refreshToken });
    expect(res.body.code).toBe('INVALID_GRANT');
  });

  it('caducidad absoluta superada → 410 EXPIRED_TOKEN', async () => {
    const u = await createUser({ academic: ac });
    const { svc, externalUserId, refreshToken } = await linkChannel(app, u.email);
    await prisma.channelSession.updateMany({ data: { absoluteExpiresAt: new Date(Date.now() - 1000) } });
    const res = await request(app).post('/api/v1/channel-auth/token').set(svcHeader(svc))
      .send({ grant_type: 'refresh_token', channel: 'telegram', externalUserId, refreshToken });
    expect(res.status).toBe(410);
  });

  it('RF-TGB-09: /desvincular revoca la identidad (EP-C-09 scope=identity)', async () => {
    const u = await createUser({ academic: ac });
    const { svc, accessToken } = await linkChannel(app, u.email);
    await bot(app, svc, accessToken).post('/api/v1/channel-auth/revoke').send({ scope: 'identity' }).expect(204);
    await bot(app, svc, accessToken).get('/api/v1/offers/me').expect(401);
    expect(await prisma.channelIdentity.count({ where: { userId: u.id, revokedAt: null } })).toBe(0);
  });

  it('RF-TGB-09: también desde Ajustes web (EP-C-10 / EP-C-11)', async () => {
    const u = await createUser({ academic: ac });
    const { svc, accessToken } = await linkChannel(app, u.email);
    const web = await webAgent(app, u.email);
    const list = await web.get('/api/v1/me/channels').expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ channel: 'telegram', displayName: 'Ana TG' });
    await web.delete(`/api/v1/me/channels/${list.body[0].identityId}`).expect(204);
    await bot(app, svc, accessToken).get('/api/v1/offers/me').expect(401);
    await web.delete(`/api/v1/me/channels/${list.body[0].identityId}`).expect(404);
  });

  it('CA-20: el bloqueo revoca la sesión de canal, el bot recibe el evento y toda acción falla', async () => {
    const events = eventCollector();
    await events.start();
    const emb = await createUser({ academic: ac, role: Role.EMBAJADOR });
    await prisma.adminScope.create({ data: { userId: emb.id, carreraId: ac.carrera.id } });
    const u = await createUser({ academic: ac });
    const { svc, accessToken, externalUserId, refreshToken } = await linkChannel(app, u.email);
    await (await webAgent(app, emb.email)).post('/api/admin/users/block').send({ targetId: u.id, reason: 'motivo de prueba' }).expect(200);
    expect((await bot(app, svc, accessToken).get('/api/v1/offers/me')).status).toBe(401);
    const ref = await request(app).post('/api/v1/channel-auth/token').set(svcHeader(svc))
      .send({ grant_type: 'refresh_token', channel: 'telegram', externalUserId, refreshToken });
    expect(ref.body.code).toBe('INVALID_GRANT');
    const types = (await events.collect()).map((e) => [e.type, (e.data as { reason?: string }).reason]);
    expect(types).toEqual(expect.arrayContaining([['account.blocked', 'motivo de prueba'], ['channel.session.revoked', 'BLOCKED']]));
  });
});

describe('Login y registro dentro del chat (EP-C-07, EP-C-08)', () => {
  it('EP-C-07 responde igual exista o no la cuenta (anti-enumeración)', async () => {
    const u = await createUser({ academic: ac });
    const svc = await serviceToken(app);
    const a = await request(app).post('/api/v1/channel-auth/email-otp').set(svcHeader(svc)).send({ channel: 'telegram', externalUserId: '1', email: u.email.toUpperCase() });
    const b = await request(app).post('/api/v1/channel-auth/email-otp').set(svcHeader(svc)).send({ channel: 'telegram', externalUserId: '2', email: 'nadie@alumnos.unican.es' });
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    expect(Object.keys(a.body).sort()).toEqual(Object.keys(b.body).sort());
    expect(mailbox.filter((m) => m.otp)).toHaveLength(1);
    // Con el email inexistente el código siempre es inválido
    const tok = await request(app).post('/api/v1/channel-auth/token').set(svcHeader(svc))
      .send({ grant_type: 'email_otp', channel: 'telegram', externalUserId: '2', challengeToken: b.body.challengeToken, code: '123456' });
    expect(tok.body.code).toBe('INVALID_GRANT');
  });

  it('EP-C-07 exige dominio institucional (400 INVALID_EMAIL_DOMAIN)', async () => {
    const svc = await serviceToken(app);
    const res = await request(app).post('/api/v1/channel-auth/email-otp').set(svcHeader(svc)).send({ channel: 'telegram', externalUserId: '1', email: 'x@gmail.com' });
    expect(res.body.code).toBe('INVALID_EMAIL_DOMAIN');
  });

  it('login por OTP de correo sin MFA emite la sesión y crea la identidad', async () => {
    const u = await createUser({ academic: ac });
    const svc = await serviceToken(app);
    const otp = await request(app).post('/api/v1/channel-auth/email-otp').set(svcHeader(svc)).send({ channel: 'telegram', externalUserId: '31', email: u.email }).expect(202);
    const tok = await request(app).post('/api/v1/channel-auth/token').set(svcHeader(svc))
      .send({ grant_type: 'email_otp', channel: 'telegram', externalUserId: '31', challengeToken: otp.body.challengeToken, code: lastOtpFor(u.email) })
      .expect(200);
    expect(tok.body.user.id).toBe(u.id);
    expect(await prisma.channelIdentity.count({ where: { userId: u.id, externalUserId: '31', revokedAt: null } })).toBe(1);
  });

  it('CA-22: con MFA, el OTP de correo solo da un reto; la sesión requiere el código XOTP', async () => {
    const u = await createUser({ academic: ac });
    await enableMfa(app, fakeMfa, u.id, u.email);
    const svc = await serviceToken(app);
    const otp = await request(app).post('/api/v1/channel-auth/email-otp').set(svcHeader(svc)).send({ channel: 'telegram', externalUserId: '32', email: u.email }).expect(202);
    const step1 = await request(app).post('/api/v1/channel-auth/token').set(svcHeader(svc))
      .send({ grant_type: 'email_otp', channel: 'telegram', externalUserId: '32', challengeToken: otp.body.challengeToken, code: lastOtpFor(u.email) })
      .expect(200);
    expect(step1.body).toMatchObject({ mfaRequired: true, expiresIn: 300, methods: ['xotp', 'recovery_code'] });
    expect(step1.body.accessToken).toBeUndefined();
    expect(await prisma.channelSession.count()).toBe(0);

    const bad = await request(app).post('/api/v1/channel-auth/token').set(svcHeader(svc))
      .send({ grant_type: 'mfa', channel: 'telegram', externalUserId: '32', challengeToken: step1.body.challengeToken, code: '000000' });
    expect(bad.status).toBe(401);
    expect(bad.body.code).toBe('MFA_INVALID_CODE');
    expect(bad.body.details.remainingAttempts).toBeLessThan(5);

    const ok = await request(app).post('/api/v1/channel-auth/token').set(svcHeader(svc))
      .send({ grant_type: 'mfa', channel: 'telegram', externalUserId: '32', challengeToken: step1.body.challengeToken, code: fakeMfa.engine.nextCode(u.id) })
      .expect(200);
    expect(ok.body.user).toMatchObject({ id: u.id, mfaEnabled: true });
    // El reto es de un solo uso (aunque llegue un código válido de un paso posterior)
    fakeMfa.engine.advance(60_000);
    const reuse = await request(app).post('/api/v1/channel-auth/token').set(svcHeader(svc))
      .send({ grant_type: 'mfa', channel: 'telegram', externalUserId: '32', challengeToken: step1.body.challengeToken, code: fakeMfa.engine.nextCode(u.id) });
    expect(reuse.body.code).toBe('INVALID_GRANT');
  });

  it('RF-TGB-03 / ADR-29: el alta desde el bot crea la cuenta sin contraseña, con identidad y sesión', async () => {
    const svc = await serviceToken(app);
    const email = `tg${Date.now()}@alumnos.unican.es`;
    const reg = await request(app).post('/api/v1/channel-auth/register').set(svcHeader(svc)).set('Idempotency-Key', 'tg:900')
      .send({ channel: 'telegram', externalUserId: '61', name: 'Nuevo TG', email, carreraId: ac.carrera.id, cursoId: ac.curso.id, acceptTerms: true })
      .expect(202);
    expect(reg.body).toMatchObject({ expiresIn: 1800, codeLength: 6 });
    const tok = await request(app).post('/api/v1/channel-auth/token').set(svcHeader(svc))
      .send({ grant_type: 'registration_otp', channel: 'telegram', externalUserId: '61', challengeToken: reg.body.challengeToken, code: lastOtpFor(email) })
      .expect(200);
    expect(tok.body.user).toMatchObject({ name: 'Nuevo TG', hasExpediente: false });
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.passwordHash).toBeNull();
    // No puede entrar por la web con contraseña hasta fijarla
    expect((await request(app).post('/api/auth/login').send({ email, password: PASSWORD })).status).toBe(401);
  });

  it('EP-C-08 valida acceptTerms, dominio y que la identidad no esté vinculada', async () => {
    const u = await createUser({ academic: ac });
    await linkChannel(app, u.email, '62');
    const svc = await serviceToken(app);
    const base = { channel: 'telegram', name: 'X Y', carreraId: ac.carrera.id, cursoId: ac.curso.id };
    const terms = await request(app).post('/api/v1/channel-auth/register').set(svcHeader(svc)).set('Idempotency-Key', 'tg:1')
      .send({ ...base, externalUserId: '63', email: 'a@alumnos.unican.es', acceptTerms: false });
    expect(terms.status).toBe(400);
    const taken = await request(app).post('/api/v1/channel-auth/register').set(svcHeader(svc)).set('Idempotency-Key', 'tg:2')
      .send({ ...base, externalUserId: '62', email: 'b@alumnos.unican.es', acceptTerms: true });
    expect(taken.body.code).toBe('CHANNEL_IDENTITY_TAKEN');
    const dup = await request(app).post('/api/v1/channel-auth/register').set(svcHeader(svc)).set('Idempotency-Key', 'tg:3')
      .send({ ...base, externalUserId: '64', email: u.email, acceptTerms: true });
    expect(dup.body.code).toBe('EMAIL_TAKEN');
  });
});

describe('EP-C-17 / EP-C-18 preferencias de notificación', () => {
  it('el correo no se puede desactivar; Telegram solo si está vinculado', async () => {
    const u = await createUser({ academic: ac });
    const web = await webAgent(app, u.email);
    const prefs = await web.get('/api/v1/me/notification-preferences').expect(200);
    expect(prefs.body).toEqual({
      email: { enabled: true, editable: false },
      telegram: { enabled: false, linked: false, chatMessages: true },
      web: { enabled: true },
    });
    await web.patch('/api/v1/me/notification-preferences').send({ email: { enabled: false } }).expect(400);
    await web.patch('/api/v1/me/notification-preferences').send({ telegram: { enabled: true } }).expect(409);

    const { svc, accessToken } = await linkChannel(app, u.email);
    const upd = await bot(app, svc, accessToken).patch('/api/v1/me/notification-preferences').send({ telegram: { chatMessages: false } }).expect(200);
    expect(upd.body.telegram).toEqual({ enabled: true, linked: true, chatMessages: false });
  });

  it('las notificaciones del bot: no leídas, contador y marcar leída (EP-R-14..16)', async () => {
    const u = await createUser({ academic: ac });
    const { svc, accessToken } = await linkChannel(app, u.email);
    const tg = bot(app, svc, accessToken);
    const count = await tg.get('/api/v1/notifications/unread-count').expect(200);
    expect(count.body.count).toBeGreaterThan(0);
    const list = await tg.get('/api/v1/notifications?unread=true&limit=1').expect(200);
    expect(list.body).toHaveLength(1);
    await tg.patch(`/api/v1/notifications/${list.body[0].id}/read`).expect(200);
    await tg.patch('/api/v1/notifications/ckinexistente00000000000/read').expect(404);
  });
});
