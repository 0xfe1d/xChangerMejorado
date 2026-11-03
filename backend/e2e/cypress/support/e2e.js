// Comandos de alto nivel que reproducen cómo usan la API la web y el bot.

const api = (p) => `/api/v1${p}`;

Cypress.Commands.add('api', (method, path, body, opts = {}) =>
  cy.request({ method, url: api(path), body, failOnStatusCode: false, ...opts }),
);

/** Login web por cookies (sin MFA). */
Cypress.Commands.add('webLogin', (email, password = 'Secreta#2026') => {
  cy.clearCookies();
  return cy.api('POST', '/auth/login', { email, password }).then((r) => {
    expect(r.status).to.eq(200);
    expect(r.body.mfaRequired).to.not.eq(true);
  });
});

/** JWT de servicio del bot (EP-C-01). */
Cypress.Commands.add('serviceToken', () =>
  cy
    .api('POST', '/service-auth/token', { grant_type: 'client_credentials', client_id: 'telegram-bot', client_secret: Cypress.env('botSecret') })
    .then((r) => {
      expect(r.status).to.eq(200);
      return r.body.access_token;
    }),
);

/** Petición como el bot: cabecera de servicio + Bearer de canal, sin cookies. */
Cypress.Commands.add('bot', (svc, accessToken, method, path, body, headers = {}) => {
  cy.clearCookies();
  return cy.api(method, path, body, {
    headers: { 'X-Service-Authorization': `Bearer ${svc}`, ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}), ...headers },
  });
});

/** Vinculación completa (CA-18): devuelve { svc, accessToken, refreshToken, externalUserId }. */
Cypress.Commands.add('linkTelegram', (email, externalUserId) => {
  let svc;
  let lr;
  return cy
    .serviceToken()
    .then((t) => {
      svc = t;
      return cy.bot(svc, null, 'POST', '/channel-auth/link-requests', { channel: 'telegram', externalUserId, displayName: 'Ana TG' });
    })
    .then((r) => {
      expect(r.status).to.eq(201);
      lr = r.body;
      return cy.webLogin(email);
    })
    .then(() => cy.api('POST', `/channel-links/${lr.userCode}/decision`, { decision: 'approve' }))
    .then((r) => {
      expect(r.status).to.eq(200);
      return cy.bot(svc, null, 'POST', '/channel-auth/token', { grant_type: 'link_code', channel: 'telegram', externalUserId, deviceCode: lr.deviceCode });
    })
    .then((r) => {
      expect(r.status).to.eq(200);
      return { svc, accessToken: r.body.accessToken, refreshToken: r.body.refreshToken, externalUserId };
    });
});

beforeEach(() => {
  cy.task('resetAll');
});
