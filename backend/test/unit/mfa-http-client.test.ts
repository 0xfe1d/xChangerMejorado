import { createLocalJWKSet, jwtVerify } from 'jose';
import { HttpMfaGateway } from '../../src/services/mfa/mfa.http-client';
import { initServiceKeys, getJwks } from '../../src/services/service-auth.service';

beforeAll(() => initServiceKeys());

type Handler = (url: string, init: RequestInit) => Promise<Response>;
const json = (status: number, body?: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function gateway(handler: Handler, timeoutMs = 2000) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { gw: new HttpMfaGateway('http://mfa:8081', timeoutMs, fetchImpl), calls };
}

const verifyInput = { subjectId: 'cku1', code: '123456', purpose: 'login' as const, correlationId: 'jti-1' };

describe('cliente HTTP del mfa-service (§10.2, §10.3)', () => {
  it('envía un JWT de servicio del core con aud=mfa-service y scope mfa:manage', async () => {
    const { gw, calls } = gateway(async () => json(200, { valid: true, factorId: 'f', matchedStep: 1, driftSteps: 0, driftWarning: false }));
    await gw.verify(verifyInput);
    expect(calls[0].url).toBe('http://mfa:8081/v1/verify');
    const auth = (calls[0].init.headers as Record<string, string>).Authorization;
    const { payload } = await jwtVerify(auth.replace('Bearer ', ''), createLocalJWKSet(getJwks()), { audience: 'mfa-service', issuer: 'xchanger-core' });
    expect(payload.scope).toBe('mfa:manage');
  });

  it('traduce 423 a MFA_LOCKED con retryAfter', async () => {
    const { gw } = gateway(async () => json(423, { code: 'LOCKED', retryAfter: 120 }));
    await expect(gw.verify(verifyInput)).rejects.toMatchObject({ statusCode: 423, code: 'MFA_LOCKED', details: { retryAfter: 120 } });
  });

  it('devuelve el resultado inválido (REPLAYED) sin lanzar', async () => {
    const { gw } = gateway(async () => json(200, { valid: false, reason: 'REPLAYED', remainingAttempts: 3 }));
    await expect(gw.verify(verifyInput)).resolves.toEqual({ valid: false, reason: 'REPLAYED', remainingAttempts: 3 });
  });

  it('falla cerrado con 503 MFA_SERVICE_UNAVAILABLE ante caída o 5xx', async () => {
    const { gw } = gateway(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(gw.verify(verifyInput)).rejects.toMatchObject({ statusCode: 503, code: 'MFA_SERVICE_UNAVAILABLE' });
    const { gw: gw2 } = gateway(async () => json(502, { error: 'bad gateway' }));
    await expect(gw2.verify(verifyInput)).rejects.toMatchObject({ code: 'MFA_SERVICE_UNAVAILABLE' });
  });

  it('respeta el tiempo límite de la llamada', async () => {
    const { gw } = gateway(
      (_u, init) =>
        new Promise((_, rej) => {
          init.signal?.addEventListener('abort', () => rej(new Error('aborted')));
        }),
      50,
    );
    await expect(gw.verify(verifyInput)).rejects.toMatchObject({ code: 'MFA_SERVICE_UNAVAILABLE' });
  });

  it('abre el circuito tras 5 fallos y deja de llamar', async () => {
    const { gw, calls } = gateway(async () => json(500, {}));
    for (let i = 0; i < 5; i++) await expect(gw.verify(verifyInput)).rejects.toBeTruthy();
    expect(gw.breaker.state).toBe('open');
    await expect(gw.verify(verifyInput)).rejects.toMatchObject({ code: 'MFA_SERVICE_UNAVAILABLE' });
    expect(calls).toHaveLength(5);
  });

  it('reintenta una vez solo las lecturas (EP-M-06)', async () => {
    let n = 0;
    const { gw, calls } = gateway(async () =>
      ++n === 1 ? json(503, {}) : json(200, { enabled: false, factors: [], recoveryCodesRemaining: 0, pendingEnrollment: null }),
    );
    await expect(gw.getFactors('cku1')).resolves.toMatchObject({ enabled: false });
    expect(calls).toHaveLength(2);

    let m = 0;
    const { gw: gw2, calls: calls2 } = gateway(async () => (++m === 1 ? json(503, {}) : json(200, { valid: true })));
    await expect(gw2.verify(verifyInput)).rejects.toMatchObject({ code: 'MFA_SERVICE_UNAVAILABLE' });
    expect(calls2).toHaveLength(1);
  });

  it('mapea 409 de enrolamiento a MFA_ALREADY_ENABLED y 410 a ENROLLMENT_EXPIRED', async () => {
    const { gw } = gateway(async (url) => (url.endsWith('/confirm') ? json(410, { code: 'ENROLLMENT_EXPIRED' }) : json(409, { code: 'FACTOR_ALREADY_ACTIVE' })));
    await expect(gw.createEnrollment({ subjectId: 'x', accountLabel: 'a***@x' })).rejects.toMatchObject({ code: 'MFA_ALREADY_ENABLED' });
    await expect(gw.confirmEnrollment('enr_1', { subjectId: 'x', code: '123456' })).rejects.toMatchObject({ code: 'ENROLLMENT_EXPIRED' });
  });
});
