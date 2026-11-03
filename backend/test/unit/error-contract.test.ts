import express from 'express';
import request from 'supertest';
import { AppError, errorHandler, defaultCode } from '../../src/middleware/errorHandler';
import { requestId } from '../../src/middleware/requestId';

function appThrowing(err: unknown) {
  const app = express();
  app.use(requestId);
  app.use(express.json({ limit: '1kb' }));
  app.post('/x', () => {
    throw err;
  });
  app.get('/x', () => {
    throw err;
  });
  app.use(errorHandler);
  return app;
}

describe('contrato de error homogéneo (§5.10)', () => {
  it('incluye error, code estable y requestId (eco de X-Request-Id)', async () => {
    const res = await request(appThrowing(new AppError(409, 'Ya cerrada', 'OFFER_ALREADY_CLOSED')))
      .get('/x')
      .set('X-Request-Id', '01JC9ABCDEFGH');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Ya cerrada', code: 'OFFER_ALREADY_CLOSED', requestId: '01JC9ABCDEFGH' });
    expect(res.headers['x-request-id']).toBe('01JC9ABCDEFGH');
  });

  it('asigna un code por defecto a los errores antiguos sin code', () => {
    expect(new AppError(404, 'x').code).toBe('NOT_FOUND');
    expect(defaultCode(429)).toBe('RATE_LIMITED');
  });

  it('expone details.retryAfter y la cabecera Retry-After', async () => {
    const res = await request(appThrowing(new AppError(423, 'Bloqueado', 'MFA_LOCKED', { retryAfter: 30 }))).get('/x');
    expect(res.body.details).toEqual({ retryAfter: 30 });
    expect(res.headers['retry-after']).toBe('30');
  });

  it('mantiene `detail` para el modal de cuenta bloqueada del frontend', async () => {
    const res = await request(appThrowing(new AppError(403, 'Bloqueada', 'ACCOUNT_BLOCKED', { permanent: true, reason: 'spam' }))).get('/x');
    expect(res.body.detail).toMatchObject({ blocked: true, permanent: true, reason: 'spam' });
  });

  it('oculta los errores inesperados tras un 500 genérico', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await request(appThrowing(new Error('detalle interno secreto'))).get('/x');
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('secreto');
    expect(res.body.code).toBe('INTERNAL_ERROR');
  });

  it('genera un X-Request-Id si no llega o es inválido', async () => {
    const res = await request(appThrowing(new AppError(400, 'x'))).get('/x').set('X-Request-Id', 'a b');
    expect(res.headers['x-request-id']).toMatch(/^[0-9A-Z]{26}$/);
  });

  it('responde 413 PAYLOAD_TOO_LARGE ante cuerpos demasiado grandes (RV-07)', async () => {
    const res = await request(appThrowing(new AppError(500, 'no llega'))).post('/x').send({ big: 'x'.repeat(5000) });
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('PAYLOAD_TOO_LARGE');
  });
});
