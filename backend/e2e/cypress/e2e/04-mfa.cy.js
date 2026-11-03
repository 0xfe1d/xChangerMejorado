// MFA de extremo a extremo: navegador ↔ core ↔ mfa-service (stub HTTP que valida el JWKS del core).
describe('MFA con protocolo XOTP (core como relying party)', () => {
  let s;
  beforeEach(() => cy.task('seed').then((x) => (s = x)));

  const enable = (user) =>
    cy.webLogin(user.email)
      .then(() => cy.api('POST', '/auth/reauthenticate', { password: s.password }))
      .then(() => cy.api('POST', '/auth/mfa/enrollments'))
      .then((enr) => {
        expect(enr.status).to.eq(201);
        expect(enr.headers['cache-control']).to.eq('no-store');
        return cy.task('mfaCode', user.id).then((code) => cy.api('POST', `/auth/mfa/enrollments/${enr.body.enrollmentId}/confirm`, { code }));
      })
      .then((conf) => {
        expect(conf.status).to.eq(200);
        expect(conf.body.recoveryCodes).to.have.length(10);
        return cy.task('mfaAdvance', 30000).then(() => conf.body.recoveryCodes);
      });

  it('CA-13 + CA-14: activar y entrar con segundo factor; sin cookies de sesión antes del código', () => {
    enable(s.ana);
    cy.clearCookies();
    cy.api('POST', '/auth/login', { email: s.ana.email, password: s.password }).then((r) => {
      expect(r.body).to.deep.eq({ mfaRequired: true, methods: ['xotp', 'recovery_code'], expiresIn: 300 });
    });
    cy.getCookie('access_token').should('be.null');
    cy.getCookie('mfa_challenge').should('exist');
    cy.task('mfaCode', s.ana.id).then((code) => cy.api('POST', '/auth/mfa/challenge', { code })).its('status').should('eq', 200);
    cy.api('GET', '/auth/me').its('body.mfaEnabled').should('eq', true);
  });

  it('CA-15: reenviar un código ya usado → 401 REPLAYED', () => {
    enable(s.ana);
    cy.task('mfaCode', s.ana.id).then((code) => {
      cy.clearCookies();
      cy.api('POST', '/auth/login', { email: s.ana.email, password: s.password });
      cy.api('POST', '/auth/mfa/challenge', { code }).its('status').should('eq', 200);
      cy.clearCookies();
      cy.api('POST', '/auth/login', { email: s.ana.email, password: s.password });
      cy.api('POST', '/auth/mfa/challenge', { code }).then((r) => {
        expect(r.status).to.eq(401);
        expect(r.body.details.reason).to.eq('REPLAYED');
      });
    });
  });

  it('CA-17: mfa-service caído → 503 para usuarios con MFA; los demás entran', () => {
    enable(s.ana);
    cy.task('mfaDown', true);
    cy.clearCookies();
    cy.api('POST', '/auth/login', { email: s.ana.email, password: s.password });
    cy.api('POST', '/auth/mfa/challenge', { code: '123456' }).its('body.code').should('eq', 'MFA_SERVICE_UNAVAILABLE');
    cy.webLogin(s.beto.email);
    cy.task('mfaDown', false);
  });

  it('CA-22: por el bot, OTP de correo + XOTP antes de emitir la sesión', () => {
    enable(s.ana);
    cy.serviceToken().then((svc) => {
      cy.bot(svc, null, 'POST', '/channel-auth/email-otp', { channel: 'telegram', externalUserId: '9090', email: s.ana.email }).then((r) => {
        expect(r.status).to.eq(202);
        cy.task('otpFor', s.ana.email).then((code) =>
          cy.bot(svc, null, 'POST', '/channel-auth/token', { grant_type: 'email_otp', channel: 'telegram', externalUserId: '9090', challengeToken: r.body.challengeToken, code }),
        ).then((step1) => {
          expect(step1.body.mfaRequired).to.eq(true);
          expect(step1.body).not.to.have.property('accessToken');
          cy.task('mfaCode', s.ana.id).then((code) =>
            cy.bot(svc, null, 'POST', '/channel-auth/token', { grant_type: 'mfa', channel: 'telegram', externalUserId: '9090', challengeToken: step1.body.challengeToken, code }),
          ).then((step2) => {
            expect(step2.status).to.eq(200);
            expect(step2.body.user.mfaEnabled).to.eq(true);
          });
        });
      });
    });
  });

  it('RF-MFA-09: la propietaria restablece el MFA de un estudiante', () => {
    enable(s.ana);
    cy.webLogin(s.owner.email);
    cy.api('POST', `/admin/users/${s.ana.id}/mfa/reset`, { reason: 'perdió el móvil, verificado en persona' }).its('status').should('eq', 204);
    cy.webLogin(s.ana.email); // vuelve a entrar sin segundo factor
  });
});
