import { decodeProtectedHeader, decodeJwt } from 'jose';
import {
  initServiceKeys,
  issueForClient,
  verifyServiceToken,
  signServiceToken,
  getJwks,
  SERVICE_TOKEN_TTL_SECONDS,
} from '../../src/services/service-auth.service';
import { AppError } from '../../src/middleware/errorHandler';

const SECRET = 'bot-test-secret-0123456789abcdefghijklmnop';

beforeAll(() => initServiceKeys());

describe('autenticación de servicios (ADR-20, EP-C-01/02)', () => {
  it('emite un JWT ES256 de 10 min con iss, sub, aud, scope, jti y kid', async () => {
    const r = await issueForClient({ clientId: 'telegram-bot', clientSecret: SECRET });
    expect(r).toMatchObject({ token_type: 'Bearer', expires_in: 600, scope: 'channel:telegram' });
    const header = decodeProtectedHeader(r.access_token);
    expect(header).toMatchObject({ alg: 'ES256', kid: 'core-dev' });
    const claims = decodeJwt(r.access_token);
    expect(claims).toMatchObject({ iss: 'xchanger-core', sub: 'telegram-bot', aud: 'xchanger-core', scope: 'channel:telegram' });
    expect(claims.jti).toBeTruthy();
    expect((claims.exp as number) - (claims.iat as number)).toBe(SERVICE_TOKEN_TTL_SECONDS);
  });

  it('rechaza secreto o cliente incorrectos con 401 SERVICE_UNAUTHORIZED', async () => {
    await expect(issueForClient({ clientId: 'telegram-bot', clientSecret: 'x'.repeat(40) })).rejects.toMatchObject({ statusCode: 401, code: 'SERVICE_UNAUTHORIZED' });
    await expect(issueForClient({ clientId: 'otro', clientSecret: SECRET })).rejects.toMatchObject({ code: 'SERVICE_UNAUTHORIZED' });
  });

  it('rechaza scopes no permitidos con 400 INVALID_SCOPE', async () => {
    await expect(issueForClient({ clientId: 'telegram-bot', clientSecret: SECRET, scope: 'mfa:manage' })).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_SCOPE' });
  });

  it('verifica el scope exigido por la ruta', async () => {
    const { access_token } = await issueForClient({ clientId: 'telegram-bot', clientSecret: SECRET });
    await expect(verifyServiceToken(access_token, 'channel:telegram')).resolves.toMatchObject({ sub: 'telegram-bot' });
    await expect(verifyServiceToken(access_token, 'channel:whatsapp')).rejects.toMatchObject({ statusCode: 403 });
  });

  it('no acepta como credencial del core un token dirigido al mfa-service', async () => {
    const t = await signServiceToken('xchanger-core', 'mfa-service', ['mfa:manage']);
    await expect(verifyServiceToken(t)).rejects.toBeInstanceOf(AppError);
  });

  it('publica la clave pública en el JWKS sin material privado', () => {
    const { keys } = getJwks();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ kty: 'EC', crv: 'P-256', kid: 'core-dev', alg: 'ES256', use: 'sig' });
    expect(keys[0]).not.toHaveProperty('d');
  });
});
