import { assertOneFactor, normalizeXotp } from '../../src/services/mfa/second-factor';
import { requireRecentAuth } from '../../src/middleware/authenticate';

describe('validación del segundo factor (§7.2.5)', () => {
  it('tolera espacios intermedios en el código', () => {
    expect(normalizeXotp('123 456')).toBe('123456');
  });

  it('exige exactamente uno de code / recoveryCode', () => {
    expect(() => assertOneFactor(undefined, undefined)).toThrow();
    expect(() => assertOneFactor('123456', 'ABCDE-12345')).toThrow();
    expect(() => assertOneFactor('123456', undefined)).not.toThrow();
    expect(() => assertOneFactor(undefined, 'abcde-12345')).not.toThrow();
  });

  it('rechaza formatos inválidos', () => {
    expect(() => assertOneFactor('12345', undefined)).toThrow();
    expect(() => assertOneFactor(undefined, 'ABC-123')).toThrow();
  });
});

describe('requireRecentAuth', () => {
  const run = (mode: 'login-or-reauth' | 'reauth', user: Record<string, unknown>) =>
    new Promise<unknown>((resolve) => requireRecentAuth(mode)({ user } as never, {} as never, resolve));
  const now = Math.floor(Date.now() / 1000);

  it('acepta un login de menos de 15 min para aprobar vinculaciones', async () => {
    await expect(run('login-or-reauth', { auth_time: now - 60 })).resolves.toBeUndefined();
  });

  it('pide REAUTH_REQUIRED si el login tiene más de 15 min', async () => {
    await expect(run('login-or-reauth', { auth_time: now - 16 * 60 })).resolves.toMatchObject({ code: 'REAUTH_REQUIRED' });
  });

  it('para activar MFA exige reautenticación explícita de menos de 10 min', async () => {
    await expect(run('reauth', { auth_time: now })).resolves.toMatchObject({ code: 'REAUTH_REQUIRED' });
    await expect(run('reauth', { auth_time: now, reauth_at: now - 60 })).resolves.toBeUndefined();
    await expect(run('reauth', { reauth_at: now - 11 * 60 })).resolves.toMatchObject({ code: 'REAUTH_REQUIRED' });
  });
});
