/** "ana.perez@alumnos.unican.es" → "a***@alumnos.unican.es" (etiqueta de cuenta XOTP). */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  return `${email[0]}***${email.slice(at)}`;
}
