import { monotonicFactory } from 'ulid';

// ULID monótono: ordenable por tiempo dentro del mismo proceso (outbox, X-Request-Id).
const ulid = monotonicFactory();

export function newUlid(): string {
  return ulid();
}

const CUID_RE = /^c[a-z0-9]{20,32}$/;
export function isCuid(value: unknown): value is string {
  return typeof value === 'string' && CUID_RE.test(value);
}
