import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hotp, matchStep, base32Encode, provisioningUri } from '../src/totp.js';

// RFC 6238, apéndice B (SHA-1): los 6 últimos dígitos de los códigos de 8
const SECRET = Buffer.from('12345678901234567890');
const VECTORS = [[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037'], [20000000000, '353130']];

test('vectores RFC 6238 SHA-1', () => {
  for (const [t, code] of VECTORS) assert.equal(hotp(SECRET, Math.floor(t / 30)), code);
});

test('ventana ±1 y rechazo fuera de ella', () => {
  const now = 1111111109 * 1000;
  assert.deepEqual(matchStep(SECRET, '081804', now), { step: 37037036, drift: 0 });
  assert.equal(matchStep(SECRET, hotp(SECRET, 37037036 + 1), now).drift, 1);
  assert.equal(matchStep(SECRET, hotp(SECRET, 37037036 + 2), now), null);
});

test('base32 RFC 4648', () => {
  assert.equal(base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI');
});

test('URI otpauth compatible con Microsoft Authenticator', () => {
  const uri = provisioningUri({ issuer: 'xChanger', account: 'a***@alumnos.unican.es', secretB32: 'ABC' });
  assert.match(uri, /^otpauth:\/\/totp\/xChanger%3Aa\*\*\*%40alumnos\.unican\.es\?/);
  const p = new URL(uri).searchParams;
  assert.equal(p.get('algorithm'), 'SHA1');
  assert.equal(p.get('digits'), '6');
  assert.equal(p.get('period'), '30');
  assert.equal(p.get('issuer'), 'xChanger');
});
