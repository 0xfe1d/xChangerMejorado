// Contratos que consume el bot de Telegram (§9), simulando sus peticiones HTTP.
describe('Canal Telegram (consumidor externo de la API)', () => {
  let s;
  beforeEach(() => cy.task('seed').then((x) => (s = x)));

  it('CA-18: vincular por código y operar como el bot', () => {
    cy.linkTelegram(s.ana.email, '424242').then(({ svc, accessToken }) => {
      cy.bot(svc, accessToken, 'GET', '/auth/me').its('body.email').should('eq', s.ana.email);
      cy.bot(svc, accessToken, 'GET', '/me/expediente').its('body').should('have.length', 1);
      cy.bot(svc, accessToken, 'GET', `/subjects/${s.asignaturaId}/groups`).its('body').should('have.length', 3);
      cy.bot(svc, accessToken, 'GET', '/offers/me').its('body').should('deep.eq', { items: [], nextCursor: null });
    });
  });

  it('CA-19: un update reintentado por Telegram crea una sola oferta', () => {
    cy.linkTelegram(s.ana.email, '5001').then(({ svc, accessToken }) => {
      const body = { asignaturaId: s.asignaturaId, grupoActualId: s.g1, grupoDeseadoId: s.g2 };
      cy.bot(svc, accessToken, 'POST', '/offers', body, { 'Idempotency-Key': 'tg:123456' }).then((r1) => {
        cy.bot(svc, accessToken, 'POST', '/offers', body, { 'Idempotency-Key': 'tg:123456' }).then((r2) => {
          expect(r2.status).to.eq(201);
          expect(r2.body.id).to.eq(r1.body.id);
          expect(r2.headers['idempotent-replayed']).to.eq('true');
        });
      });
      cy.task('dbQuery', { model: 'offer', where: {} }).its('length').should('eq', 1);
    });
  });

  it('CA-21: sin credencial de servicio → 401; rutas de administración → 403 CHANNEL_FORBIDDEN_ROUTE', () => {
    cy.linkTelegram(s.owner.email, '5002').then(({ svc, accessToken }) => {
      cy.clearCookies();
      cy.api('GET', '/offers/me', null, { headers: { Authorization: `Bearer ${accessToken}` } }).its('status').should('eq', 401);
      cy.bot(svc, accessToken, 'GET', '/admin/logs').its('body.code').should('eq', 'CHANNEL_FORBIDDEN_ROUTE');
    });
  });

  it('refresco con rotación y desvinculación desde el bot (RF-TGB-09)', () => {
    cy.linkTelegram(s.ana.email, '5003').then(({ svc, refreshToken, externalUserId }) => {
      cy.bot(svc, null, 'POST', '/channel-auth/token', { grant_type: 'refresh_token', channel: 'telegram', externalUserId, refreshToken }).then((r) => {
        expect(r.status).to.eq(200);
        expect(r.body.refreshToken).not.to.eq(refreshToken);
        cy.bot(svc, r.body.accessToken, 'POST', '/channel-auth/revoke', { scope: 'identity' }).its('status').should('eq', 204);
        cy.bot(svc, r.body.accessToken, 'GET', '/offers/me').its('status').should('eq', 401);
      });
    });
  });

  it('CA-20: un embajador bloquea al usuario y el bot deja de poder operar', () => {
    cy.linkTelegram(s.ana.email, '5004').then(({ svc, accessToken }) => {
      cy.webLogin(s.owner.email);
      cy.api('POST', '/admin/users/block', { targetId: s.ana.id, reason: 'motivo de prueba' }).its('status').should('eq', 200);
      cy.bot(svc, accessToken, 'GET', '/offers/me').its('status').should('eq', 401);
    });
  });

  it('RF-TGB-03: alta desde el bot sin contraseña, con el OTP real de correo', () => {
    const email = 'nuevotg@alumnos.unican.es';
    cy.serviceToken().then((svc) => {
      cy.bot(svc, null, 'POST', '/channel-auth/register',
        { channel: 'telegram', externalUserId: '7777', name: 'Nuevo TG', email, carreraId: s.carreraId, cursoId: s.cursoId, acceptTerms: true },
        { 'Idempotency-Key': 'tg:7777' },
      ).then((reg) => {
        expect(reg.status).to.eq(202);
        cy.task('otpFor', email).then((code) =>
          cy.bot(svc, null, 'POST', '/channel-auth/token', { grant_type: 'registration_otp', channel: 'telegram', externalUserId: '7777', challengeToken: reg.body.challengeToken, code }),
        ).then((tok) => {
          expect(tok.status).to.eq(200);
          expect(tok.body.user).to.include({ name: 'Nuevo TG', hasExpediente: false });
        });
      });
    });
  });
});
