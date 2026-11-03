import { encodeCursor, decodeCursor, afterCursorWhere } from '../../src/utils/cursor';
import { generateUserCode, formatUserCode, normalizeUserCode, USER_CODE_ALPHABET } from '../../src/utils/user-code';
import { maskEmail } from '../../src/utils/mask';
import { canonicalHash, timingSafeEqualStr, randomToken, sha256Hex } from '../../src/utils/crypto';
import { escapeHtml } from '../../src/utils/html';
import { isCuid, newUlid } from '../../src/utils/ids';

describe('cursor de paginación (§5.6)', () => {
  it('codifica y decodifica createdAt + id de forma opaca', () => {
    const pos = { createdAt: new Date('2026-11-03T10:00:00.000Z'), id: 'ckabc' };
    const c = encodeCursor(pos);
    expect(c).not.toContain('ckabc');
    expect(decodeCursor(c)).toEqual(pos);
  });

  it('devuelve null ante cursores manipulados', () => {
    expect(decodeCursor('no-es-base64-json')).toBeNull();
    expect(decodeCursor(Buffer.from('{"t":"x","i":1}').toString('base64url'))).toBeNull();
  });

  it('genera la condición "después de" para orden descendente estable', () => {
    const at = new Date('2026-01-01T00:00:00Z');
    expect(afterCursorWhere({ createdAt: at, id: 'b' })).toEqual({
      OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: 'b' } }],
    });
    expect(afterCursorWhere(null)).toEqual({});
  });
});

describe('userCode de vinculación (§6.4)', () => {
  it('usa 8 caracteres del alfabeto sin ambigüedades', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateUserCode();
      expect(code).toHaveLength(8);
      for (const ch of code) expect(USER_CODE_ALPHABET).toContain(ch);
      expect(code).not.toMatch(/[01OI]/); // alfabeto de §6.4 (sin 0, 1, O, I)
    }
  });

  it('se muestra con guion y se normaliza sin distinguir mayúsculas', () => {
    expect(formatUserCode('ABCD2345')).toBe('ABCD-2345');
    expect(normalizeUserCode('abcd-2345')).toBe('ABCD2345');
    expect(normalizeUserCode(' ABCD 2345 ')).toBe('ABCD2345');
  });

  it('rechaza longitudes o caracteres fuera del alfabeto', () => {
    expect(normalizeUserCode('ABCD-234')).toBeNull();
    expect(normalizeUserCode('ABCD-2340')).toBeNull(); // el 0 no está en el alfabeto
  });
});

describe('utilidades criptográficas y de formato', () => {
  it('enmascara el email para la etiqueta XOTP', () => {
    expect(maskEmail('ana.perez@alumnos.unican.es')).toBe('a***@alumnos.unican.es');
  });

  it('el hash canónico no depende del orden de claves (idempotencia)', () => {
    expect(canonicalHash({ a: 1, b: { c: 2, d: [1, 2] } })).toBe(canonicalHash({ b: { d: [1, 2], c: 2 }, a: 1 }));
    expect(canonicalHash({ a: 1 })).not.toBe(canonicalHash({ a: 2 }));
  });

  it('el token opaco de refresco tiene 43 caracteres base64url (256 bits)', () => {
    const t = randomToken(32);
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sha256Hex(t)).toHaveLength(64);
  });

  it('compara cadenas en tiempo constante', () => {
    expect(timingSafeEqualStr('abc', 'abc')).toBe(true);
    expect(timingSafeEqualStr('abc', 'abcd')).toBe(false);
  });

  it('escapa HTML del contenido de correos (RF-NOT-06)', () => {
    expect(escapeHtml(`<img src=x onerror="alert('x')">&`)).toBe('&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;');
  });

  it('valida CUID y genera ULID ordenables', () => {
    expect(isCuid('clx1y2z3a0000abcdefghijkl')).toBe(true);
    expect(isCuid('1; DROP TABLE')).toBe(false);
    const a = newUlid();
    const b = newUlid();
    expect(a < b).toBe(true);
  });
});
