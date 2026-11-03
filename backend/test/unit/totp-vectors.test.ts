import { totp, base32Encode, base32Decode } from '../support/totp';

/**
 * §7.2.3: vectores obligatorios RFC 6238 (SHA-256, clave "1234567890" repetida
 * hasta 32 bytes, per=30, t0=0). El core no implementa TOTP (lo hace el
 * mfa-service), pero la simulación con la que se prueban sus contratos debe
 * superar los mismos vectores para que los tests sean fieles al protocolo.
 */
describe('vectores RFC 6238 de XOTP v1', () => {
  const key = Buffer.from('12345678901234567890123456789012', 'ascii');
  const vectors: Array<[number, string, string]> = [
    [59, '46119246', '119246'],
    [1111111109, '68084774', '084774'],
    [1234567890, '91819424', '819424'],
    [2000000000, '90698825', '698825'],
  ];

  it.each(vectors)('t=%d → %s (8 díg.) / %s (6 díg.)', (t, eight, six) => {
    expect(totp(key, t, { digits: 8 })).toBe(eight);
    expect(totp(key, t, { digits: 6 })).toBe(six);
  });

  it('el secreto de 32 bytes ocupa 52 caracteres Base32 sin relleno y es reversible', () => {
    const enc = base32Encode(key);
    expect(enc).toHaveLength(52);
    expect(base32Decode(enc).equals(key)).toBe(true);
  });
});
