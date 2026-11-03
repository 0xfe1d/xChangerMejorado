import crypto from 'crypto';
import { SignJWT, jwtVerify, importPKCS8, exportJWK, generateKeyPair, createLocalJWKSet, JWK, KeyLike } from 'jose';

import { env, ServiceClient } from '../config/env';
import { AppError } from '../middleware/errorHandler';
import { sha256Hex, timingSafeEqualStr } from '../utils/crypto';

// ADR-20: el core firma JWT de servicio con ES256 y publica su JWKS interno.
export const SERVICE_ISSUER = 'xchanger-core';
export const CORE_AUDIENCE = 'xchanger-core';
export const SERVICE_TOKEN_TTL_SECONDS = 600;
const ALG = 'ES256';

interface KeyMaterial {
  privateKey: KeyLike;
  publicJwk: JWK;
  kid: string;
}

let keys: KeyMaterial | null = null;

/** Carga la clave del entorno o, fuera de producción, genera una efímera. */
export async function initServiceKeys(): Promise<void> {
  if (keys) return;
  let privateKey: KeyLike;
  let publicKey: KeyLike;
  if (env.SERVICE_JWT_PRIVATE_KEY) {
    const pem = env.SERVICE_JWT_PRIVATE_KEY.replace(/\\n/g, '\n');
    privateKey = await importPKCS8(pem, ALG);
    publicKey = crypto.createPublicKey(privateKey as unknown as crypto.KeyObject) as unknown as KeyLike;
  } else {
    console.warn('[service-auth] SERVICE_JWT_PRIVATE_KEY ausente: usando clave ES256 efímera (solo desarrollo/test).');
    ({ privateKey, publicKey } = await generateKeyPair(ALG, { extractable: true }));
  }
  const publicJwk = await exportJWK(publicKey);
  keys = { privateKey, publicJwk: { ...publicJwk, kid: env.SERVICE_JWT_KID, alg: ALG, use: 'sig' }, kid: env.SERVICE_JWT_KID };
}

function requireKeys(): KeyMaterial {
  if (!keys) throw new Error('Claves de servicio no inicializadas (initServiceKeys)');
  return keys;
}

export function getJwks(): { keys: JWK[] } {
  return { keys: [requireKeys().publicJwk] };
}

export interface ServiceClaims {
  sub: string;
  aud: string;
  scope: string[];
  jti: string;
}

/** Firma un JWT de servicio. Se usa para el bot (vía EP-C-01) y para el propio core hacia el mfa-service. */
export async function signServiceToken(sub: string, audience: string, scopes: string[]): Promise<string> {
  const { privateKey, kid } = requireKeys();
  return new SignJWT({ scope: scopes.join(' ') })
    .setProtectedHeader({ alg: ALG, kid, typ: 'JWT' })
    .setIssuer(SERVICE_ISSUER)
    .setSubject(sub)
    .setAudience(audience)
    .setJti(crypto.randomUUID())
    .setIssuedAt()
    .setExpirationTime(`${SERVICE_TOKEN_TTL_SECONDS}s`)
    .sign(privateKey);
}

/** Verifica un JWT de servicio dirigido al core y exige el scope indicado. */
export async function verifyServiceToken(token: string, requiredScope?: string): Promise<ServiceClaims> {
  const jwks = createLocalJWKSet(getJwks());
  let payload;
  try {
    ({ payload } = await jwtVerify(token, jwks, { issuer: SERVICE_ISSUER, audience: CORE_AUDIENCE, algorithms: [ALG] }));
  } catch {
    throw new AppError(401, 'Credencial de servicio inválida', 'SERVICE_UNAUTHORIZED');
  }
  const scopes = typeof payload.scope === 'string' ? payload.scope.split(' ').filter(Boolean) : [];
  if (requiredScope && !scopes.includes(requiredScope)) {
    throw new AppError(403, 'La credencial de servicio no tiene el scope requerido', 'SERVICE_FORBIDDEN');
  }
  return { sub: String(payload.sub), aud: CORE_AUDIENCE, scope: scopes, jti: String(payload.jti) };
}

function findClient(clientId: string): ServiceClient | undefined {
  return env.SERVICE_CLIENTS.find((c) => c.clientId === clientId);
}

export interface ClientCredentialsInput {
  clientId: string;
  clientSecret: string;
  scope?: string;
}

/** EP-C-01: canjea client_id/client_secret por un JWT de servicio de 10 min. */
export async function issueForClient(input: ClientCredentialsInput) {
  const client = findClient(input.clientId);
  // Se calcula el hash aunque el cliente no exista para no distinguir por tiempo
  const presented = sha256Hex(input.clientSecret);
  const valid = client ? timingSafeEqualStr(presented, client.secretSha256) : timingSafeEqualStr(presented, '0'.repeat(64)) && false;
  if (!client || !valid) {
    throw new AppError(401, 'Credenciales de servicio incorrectas', 'SERVICE_UNAUTHORIZED');
  }

  const requested = input.scope ? input.scope.split(' ').filter(Boolean) : client.scopes;
  const invalid = requested.filter((s) => !client.scopes.includes(s));
  if (invalid.length > 0 || requested.length === 0) {
    throw new AppError(400, 'Scope no permitido para este cliente', 'INVALID_SCOPE', { invalid });
  }

  const accessToken = await signServiceToken(client.clientId, CORE_AUDIENCE, requested);
  return { access_token: accessToken, token_type: 'Bearer' as const, expires_in: SERVICE_TOKEN_TTL_SECONDS, scope: requested.join(' ') };
}

/** Solo para tests: permite reiniciar las claves. */
export function __resetServiceKeysForTests(): void {
  keys = null;
}
