// Cursor opaco para paginación estable por (createdAt desc, id desc) — §5.6.
export interface CursorPosition {
  createdAt: Date;
  id: string;
}

export function encodeCursor(pos: CursorPosition): string {
  return Buffer.from(JSON.stringify({ t: pos.createdAt.toISOString(), i: pos.id })).toString('base64url');
}

/** Devuelve null si el cursor es inválido (el controlador responde 400). */
export function decodeCursor(cursor: string): CursorPosition | null {
  try {
    const raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { t?: unknown; i?: unknown };
    if (typeof raw.t !== 'string' || typeof raw.i !== 'string') return null;
    const createdAt = new Date(raw.t);
    if (Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id: raw.i };
  } catch {
    return null;
  }
}

/**
 * Condición Prisma "estrictamente después del cursor" en orden descendente.
 * Se usa con orderBy [{ createdAt: 'desc' }, { id: 'desc' }].
 */
export function afterCursorWhere(pos: CursorPosition | null) {
  if (!pos) return {};
  return {
    OR: [{ createdAt: { lt: pos.createdAt } }, { createdAt: pos.createdAt, id: { lt: pos.id } }],
  };
}
