// RS-04/RS-05: flujo completo de intercambio entre dos estudiantes por HTTP.
describe('Web: ofertas y chat', () => {
  let s;
  beforeEach(() => cy.task('seed').then((x) => (s = x)));

  it('CA-04 + CA-06: publicar, encontrar la complementaria, aceptar, chatear y cerrar', () => {
    let offerId;
    cy.webLogin(s.ana.email);
    cy.api('POST', '/offers', { asignaturaId: s.asignaturaId, grupoActualId: s.g1, grupoDeseadoId: s.g2 }).then((r) => {
      expect(r.status).to.eq(201);
      offerId = r.body.id;
    });

    cy.webLogin(s.beto.email);
    cy.api('GET', `/offers?asignaturaId=${s.asignaturaId}&grupoActualId=${s.g2}&grupoDeseadoId=${s.g1}`).then((r) => {
      expect(r.body.map((o) => o.id)).to.deep.eq([offerId]);
    });
    cy.then(() => cy.api('POST', `/offers/${offerId}/accept`)).its('body.status').should('eq', 'ACCEPTED');
    cy.then(() => cy.api('POST', `/offers/${offerId}/messages`, { content: '¿Cambiamos el jueves?' })).its('status').should('eq', 201);

    cy.webLogin(s.ana.email);
    cy.then(() => cy.api('GET', `/offers/${offerId}`)).then((r) => {
      expect(r.body.messages.map((m) => m.content)).to.deep.eq(['¿Cambiamos el jueves?']);
    });
    cy.then(() => cy.api('GET', '/notifications')).then((r) => {
      const asuntos = r.body.map((n) => n.asunto);
      expect(asuntos).to.include('Oferta de cambio de grupo aceptada');
      expect(asuntos).to.include('Nuevo mensaje en tu cambio de grupo');
    });
    cy.then(() => cy.api('PATCH', `/offers/${offerId}/close`)).its('status').should('eq', 200);
    cy.then(() => cy.api('PATCH', `/offers/${offerId}/close`)).its('body.code').should('eq', 'OFFER_ALREADY_CLOSED');
    cy.then(() => cy.api('POST', `/offers/${offerId}/messages`, { content: 'tarde' })).its('body.code').should('eq', 'CHAT_CLOSED');
  });

  it('RF-NOT-01: las notificaciones también llegan por correo (consumidor email-sender)', () => {
    cy.webLogin(s.ana.email);
    cy.api('POST', '/offers', { asignaturaId: s.asignaturaId, grupoActualId: s.g1, grupoDeseadoId: s.g3 });
    // El correo sale de forma asíncrona por el bus: se espera a que llegue
    const poll = (n) =>
      cy.task('mailCount', s.ana.email).then((c) => {
        if (c >= 2 || n === 0) return expect(c).to.be.gte(2); // aviso de login + oferta publicada
        cy.wait(300);
        return poll(n - 1);
      });
    poll(20);
  });
});
