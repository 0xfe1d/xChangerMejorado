/**
 * Convierte una duración con el formato que usa jsonwebtoken ("15m", "7d", "30d",
 * "3600" = segundos) a milisegundos, para que las cookies caduquen a la vez que
 * los JWT que contienen. Devuelve null si el formato no se reconoce.
 */
const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

export function durationToMs(value: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)?\s*$/i.exec(value);
  if (!m) return null;
  const n = Number(m[1]);
  // jsonwebtoken interpreta un número sin unidad como segundos
  const unit = (m[2] ?? 's').toLowerCase();
  return Math.round(n * UNIT_MS[unit]);
}
