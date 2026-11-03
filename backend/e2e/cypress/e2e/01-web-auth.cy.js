// RS-01 desde la perspectiva de un cliente web real (cookies HttpOnly).
describe('Web: registro, sesión y contrato de errores', () => {
  let seed;
  beforeEach(() => cy.task('seed').then((s) => (seed = s)));

  it('CA-01..02: alta con OTP de correo real (Mailpit) e inicio de sesión', () => {
    const email = 'nueva@alumnos.unican.es';
    cy.api('POST', '/auth/register', { email: 'x@gmail.com', name: 'Nueva', password: seed.password, carreraId: seed.carreraId, cursoId: seed.cursoId })
      .its('body.code').should('eq', 'INVALID_EMAIL_DOMAIN');

    cy.api('POST', '/auth/register', { email, name: 'Nueva Alumna', password: seed.password, carreraId: seed.carreraId, cursoId: seed.cursoId })
      .its('status').should('eq', 202);
    cy.getCookie('otp_token').should('have.property', 'httpOnly', true);
    cy.task('otpFor', email).then((otp) => cy.api('POST', '/auth/verify-otp', { otpCode: otp }).its('status').should('eq', 201));
    cy.api('GET', '/auth/me').then((r) => {
      expect(r.status).to.eq(200);
      expect(r.body).to.include({ email, role: 'ESTUDIANTE', mfaEnabled: false });
    });
  });

  it('login, refresco y logout; /api es alias de /api/v1', () => {
    cy.webLogin(seed.ana.email);
    cy.getCookie('access_token').should('have.property', 'httpOnly', true);
    cy.request('/api/auth/me').its('body.email').should('eq', seed.ana.email);
    // La cookie de refresco va acotada a la ruta del prefijo con el que se inició sesión (RF-AUT-11)
    cy.getCookie('refresh_token').should('have.property', 'path', '/api/v1/auth/refresh');
    cy.request({ method: 'POST', url: '/api/v1/auth/refresh' }).its('status').should('eq', 200);
    cy.api('POST', '/auth/logout').its('status').should('eq', 200);
    cy.api('GET', '/auth/me').its('status').should('eq', 401);
  });

  it('RF-AUT-09: respuesta genérica idéntica para email inexistente y contraseña errónea', () => {
    cy.api('POST', '/auth/login', { email: 'nadie@alumnos.unican.es', password: seed.password }).then((a) => {
      cy.api('POST', '/auth/login', { email: seed.ana.email, password: 'Mala#2026x' }).then((b) => {
        expect(a.status).to.eq(401);
        expect(b.status).to.eq(401);
        expect(a.body.error).to.eq(b.body.error);
      });
    });
  });

  it('§5.10: errores con code estable y eco de X-Request-Id', () => {
    cy.api('GET', '/offers/me', null, { headers: { 'X-Request-Id': '01JCE2ETESTREQUEST' } }).then((r) => {
      expect(r.status).to.eq(401);
      expect(r.body).to.include({ code: 'UNAUTHORIZED', requestId: '01JCE2ETESTREQUEST' });
      expect(r.headers['x-request-id']).to.eq('01JCE2ETESTREQUEST');
    });
  });

  it('EP-C-30: /health con marca de tiempo y dependencias desde la red interna', () => {
    cy.request('/health?deep=true').then((r) => {
      expect(r.body.status).to.eq('ok');
      expect(Date.parse(r.body.timestamp)).to.be.a('number');
      expect(r.body.dependencies).to.deep.eq({ db: 'up', redis: 'up', mfa: 'up' });
    });
  });
});
