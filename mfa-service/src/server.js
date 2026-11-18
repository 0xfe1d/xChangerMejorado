// mfa-service de xChanger: servidor HTTP del contrato EP-M (ver
// backend/src/services/mfa/mfa.http-client.ts). Solo es accesible desde la red
// interna de Docker y exige en cada llamada un JWT de servicio del core
// (iss=xchanger-core, aud=mfa-service, scope mfa:manage) verificado contra el
// JWKS interno del core (EP-C-02).
import http from 'node:http';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { loadKek } from './crypto.js';
import * as engine from './engine.js';

const PORT = Number(process.env.PORT ?? 8081);
const CORE_JWKS_URL = process.env.CORE_JWKS_URL ?? 'http://backend:3000/api/v1/internal/.well-known/jwks.json';
const ISSUER_NAME = process.env.MFA_ISSUER ?? 'xChanger';

loadKek(process.env.MFA_KEK);
const jwks = createRemoteJWKSet(new URL(CORE_JWKS_URL), { cooldownDuration: 30_000 });

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(body === undefined ? '' : JSON.stringify(body));
};

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 16 * 1024) throw new engine.EngineError(413, 'PAYLOAD_TOO_LARGE');
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new engine.EngineError(400, 'INVALID_JSON');
  }
}

async function authorized(req) {
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
  const url = new URL(req.url ?? '/', 'http://mfa');
  const path = url.pathname;
  const m = req.method;
  try {
    if (m === 'GET' && path === '/v1/health') {
      await engine.pool.query('SELECT 1');
      return send(res, 200, { status: 'ok', db: 'up' });
    }
    if (!(await authorized(req))) return send(res, 401, { code: 'UNAUTHORIZED' });

    let mm;
    if (m === 'POST' && path === '/v1/enrollments') return send(res, 201, await engine.createEnrollment(await readBody(req), ISSUER_NAME));
    if (m === 'POST' && (mm = path.match(/^\/v1\/enrollments\/([^/]+)\/confirm$/))) {
      return send(res, 200, await engine.confirmEnrollment(decodeURIComponent(mm[1]), await readBody(req)));
    }
    if (m === 'DELETE' && (mm = path.match(/^\/v1\/enrollments\/([^/]+)$/))) {
      await engine.deleteEnrollment(decodeURIComponent(mm[1]), url.searchParams.get('subjectId') ?? '');
      return send(res, 204);
    }
    if (m === 'POST' && path === '/v1/verify') return send(res, 200, await engine.verify(await readBody(req)));
    if (m === 'POST' && path === '/v1/recovery-codes/verify') return send(res, 200, await engine.verifyRecovery(await readBody(req)));
    if (m === 'POST' && (mm = path.match(/^\/v1\/subjects\/([^/]+)\/recovery-codes$/))) return send(res, 200, await engine.regenerate(decodeURIComponent(mm[1])));
    if (m === 'GET' && (mm = path.match(/^\/v1\/subjects\/([^/]+)\/factors$/))) return send(res, 200, await engine.status(decodeURIComponent(mm[1])));
    if (m === 'DELETE' && (mm = path.match(/^\/v1\/subjects\/([^/]+)\/factors$/))) {
      await engine.deleteFactors(decodeURIComponent(mm[1]));
      return send(res, 204);
    }
    return send(res, 404, { code: 'NOT_FOUND' });
  } catch (err) {
    if (err instanceof engine.EngineError) {
      return send(res, err.status, { code: err.code, ...(err.retryAfter ? { retryAfter: err.retryAfter } : {}) });
    }
    console.error('[mfa]', err);
    return send(res, 500, { code: 'INTERNAL' });
  }
});

async function start() {
  // La BD puede tardar en aceptar conexiones aunque el healthcheck ya pase
  for (let i = 1; ; i++) {
    try {
      await engine.migrate();
      break;
    } catch (err) {
      if (i >= 20) throw err;
      console.warn(`[mfa] BD no disponible (${err.message}); reintento ${i}/20`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  setInterval(() => engine.purge().catch((e) => console.error('[mfa] purge', e.message)), 10 * 60_000).unref();
  server.listen(PORT, () => console.log(`[mfa] escuchando en :${PORT} (JWKS del core: ${CORE_JWKS_URL})`));
}

const shutdown = () => server.close(() => engine.pool.end().finally(() => process.exit(0)));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

start().catch((err) => {
  console.error('[mfa] no se pudo arrancar:', err);
  process.exit(1);
});
