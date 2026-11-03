/**
 * Stub HTTP del mfa-service para las pruebas E2E del core (NO es el mfa-service).
 * Respeta el contrato EP-M-01..10 y valida, como haría el servicio real, el JWT
 * de servicio del core contra su JWKS interno (EP-C-02): aud=mfa-service,
 * scope mfa:manage. Expone además /__test/* para que Cypress obtenga códigos.
 *
 *   CORE_URL=http://localhost:3100 PORT=58081 npx ts-node test/stubs/mfa-stub.ts
 */
import http from 'http';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { MfaEngine, MfaEngineError } from '../support/mfa-engine';

const PORT = Number(process.env.PORT ?? 58081);
const CORE_URL = process.env.CORE_URL ?? 'http://localhost:3100';
const engine = new MfaEngine();
const jwks = createRemoteJWKSet(new URL(`${CORE_URL}/api/v1/internal/.well-known/jwks.json`));

type Res = http.ServerResponse;
const send = (res: Res, status: number, body?: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body === undefined ? '' : JSON.stringify(body));
};

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

async function authorized(req: http.IncomingMessage): Promise<boolean> {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return false;
  try {
    const { payload } = await jwtVerify(h.slice(7), jwks, { issuer: 'xchanger-core', audience: 'mfa-service', algorithms: ['ES256'] });
    return String(payload.scope ?? '').split(' ').includes('mfa:manage');
  } catch {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const path = url.pathname;
  const m = req.method;
  try {
    // ── Control de pruebas (solo stub) ──
    if (path.startsWith('/__test/')) {
      if (path === '/__test/reset') { engine.reset(); engine.now = () => Date.now(); return send(res, 204); }
      if (path === '/__test/down') { engine.down = (await readBody(req)).down === true; return send(res, 204); }
      if (path === '/__test/advance') { engine.advance(Number((await readBody(req)).ms ?? 30_000)); return send(res, 204); }
      const code = path.match(/^\/__test\/code\/([^/]+)$/);
      if (code) return send(res, 200, { code: engine.nextCode(decodeURIComponent(code[1])) });
      return send(res, 404, { code: 'NOT_FOUND' });
    }
    if (m === 'GET' && path === '/v1/health') return send(res, engine.down ? 503 : 200, { status: engine.down ? 'down' : 'ok', db: 'up', redis: 'up', kek: 'loaded' });
    if (m === 'GET' && path === '/.well-known/xotp-keys.json') return send(res, 200, { issuerId: 'xchanger-uc', keys: [], signature: 'stub' });
    if (engine.down) return send(res, 503, { code: 'UNAVAILABLE' });
    if (!(await authorized(req))) return send(res, 401, { code: 'UNAUTHORIZED' });

    let mm: RegExpMatchArray | null;
    if (m === 'POST' && path === '/v1/enrollments') return send(res, 201, engine.createEnrollment(await readBody(req)));
    if (m === 'POST' && (mm = path.match(/^\/v1\/enrollments\/([^/]+)\/confirm$/))) return send(res, 200, engine.confirmEnrollment(mm[1], await readBody(req)));
    if (m === 'DELETE' && (mm = path.match(/^\/v1\/enrollments\/([^/]+)$/))) { engine.deleteEnrollment(mm[1], url.searchParams.get('subjectId') ?? ''); return send(res, 204); }
    if (m === 'POST' && path === '/v1/verify') return send(res, 200, engine.verify(await readBody(req)));
    if (m === 'POST' && path === '/v1/recovery-codes/verify') return send(res, 200, engine.verifyRecovery(await readBody(req)));
    if (m === 'POST' && (mm = path.match(/^\/v1\/subjects\/([^/]+)\/recovery-codes$/))) return send(res, 200, engine.regenerate(mm[1]));
    if (m === 'GET' && (mm = path.match(/^\/v1\/subjects\/([^/]+)\/factors$/))) return send(res, 200, engine.status(mm[1]));
    if (m === 'DELETE' && (mm = path.match(/^\/v1\/subjects\/([^/]+)\/factors$/))) { engine.deleteFactors(mm[1]); return send(res, 204); }
    return send(res, 404, { code: 'NOT_FOUND' });
  } catch (err) {
    if (err instanceof MfaEngineError) return send(res, err.status, { code: err.code, ...(err.retryAfter ? { retryAfter: err.retryAfter } : {}) });
    console.error('[mfa-stub]', err);
    return send(res, 500, { code: 'INTERNAL' });
  }
});

server.listen(PORT, () => console.log(`[mfa-stub] escuchando en :${PORT} (JWKS del core: ${CORE_URL})`));
