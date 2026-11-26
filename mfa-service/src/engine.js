// Lógica del mfa-service (contrato EP-M que consume el core).
// Reglas: ventana ±1 paso, antirreplay por paso, 5 fallos en 5 min → bloqueo de
// 15 min, enrolamiento caduca a los 10 min, 10 códigos de recuperación de un uso.
import crypto from 'node:crypto';
import pg from 'pg';
import { base32Encode, matchStep, provisioningUri, ALGORITHM, DIGITS, PERIOD } from './totp.js';
import { encryptSecret, decryptSecret, generateRecoveryCode, hashRecoveryCode, newId } from './crypto.js';

export const ENROLLMENT_TTL_MS = 10 * 60_000;
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 5 * 60_000;
const LOCK_MS = 15 * 60_000;
const RECOVERY_CODES = 10;

export class EngineError extends Error {
  constructor(status, code, retryAfter) {
    super(code);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

// Usa PGHOST, PGPORT, PGUSER, PGPASSWORD y PGDATABASE del entorno
export const pool = new pg.Pool({ max: 10 });

export async function migrate() {
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS mfa;
    CREATE TABLE IF NOT EXISTS mfa.enrollments (
      enrollment_id TEXT PRIMARY KEY,
      subject_id    TEXT NOT NULL,
      factor_id     TEXT NOT NULL,
      secret_enc    TEXT NOT NULL,
      expires_at    TIMESTAMPTZ NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS enrollments_subject_idx ON mfa.enrollments (subject_id);
    CREATE TABLE IF NOT EXISTS mfa.factors (
      factor_id      TEXT PRIMARY KEY,
      subject_id     TEXT NOT NULL UNIQUE,
      secret_enc     TEXT NOT NULL,
      last_used_step BIGINT NOT NULL DEFAULT -1,
      activated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_used_at   TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS mfa.recovery_codes (
      id         BIGSERIAL PRIMARY KEY,
      subject_id TEXT NOT NULL,
      code_hash  TEXT NOT NULL,
      used_at    TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS recovery_subject_idx ON mfa.recovery_codes (subject_id);
    CREATE TABLE IF NOT EXISTS mfa.failures (
      subject_id TEXT NOT NULL,
      at         TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS failures_subject_idx ON mfa.failures (subject_id, at);
    CREATE TABLE IF NOT EXISTS mfa.locks (
      subject_id   TEXT PRIMARY KEY,
      locked_until TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mfa.used_correlations (
      correlation_id TEXT PRIMARY KEY,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

/** Limpieza periódica de datos caducados. */
export async function purge() {
  await pool.query(`
    DELETE FROM mfa.enrollments WHERE expires_at < now() - interval '1 hour';
    DELETE FROM mfa.failures WHERE at < now() - interval '1 hour';
    DELETE FROM mfa.locks WHERE locked_until < now();
    DELETE FROM mfa.used_correlations WHERE created_at < now() - interval '1 day';
  `);
}

// ── Límites de intentos ───────────────────────────────────────

async function checkLock(subjectId) {
  const { rows } = await pool.query('SELECT locked_until FROM mfa.locks WHERE subject_id = $1 AND locked_until > now()', [subjectId]);
  if (rows.length) {
    throw new EngineError(423, 'LOCKED', Math.ceil((rows[0].locked_until.getTime() - Date.now()) / 1000));
  }
}

/** Registra un fallo y devuelve los intentos restantes (0 = bloqueado). */
async function registerFailure(subjectId) {
  await pool.query('INSERT INTO mfa.failures (subject_id) VALUES ($1)', [subjectId]);
  const { rows } = await pool.query(
    'SELECT count(*)::int AS n FROM mfa.failures WHERE subject_id = $1 AND at > now() - make_interval(secs => $2)',
    [subjectId, FAILURE_WINDOW_MS / 1000],
  );
  const n = rows[0].n;
  if (n >= MAX_FAILURES) {
    await pool.query(
      `INSERT INTO mfa.locks (subject_id, locked_until) VALUES ($1, now() + make_interval(secs => $2))
       ON CONFLICT (subject_id) DO UPDATE SET locked_until = EXCLUDED.locked_until`,
      [subjectId, LOCK_MS / 1000],
    );
    await pool.query('DELETE FROM mfa.failures WHERE subject_id = $1', [subjectId]);
    return 0;
  }
  return MAX_FAILURES - n;
}

async function clearFailures(subjectId) {
  await pool.query('DELETE FROM mfa.failures WHERE subject_id = $1', [subjectId]);
}

async function newRecoveryCodes(client, subjectId) {
  const codes = Array.from({ length: RECOVERY_CODES }, generateRecoveryCode);
  await client.query('DELETE FROM mfa.recovery_codes WHERE subject_id = $1', [subjectId]);
  for (const c of codes) {
    await client.query('INSERT INTO mfa.recovery_codes (subject_id, code_hash) VALUES ($1, $2)', [subjectId, hashRecoveryCode(c)]);
  }
  return codes;
}

// ── EP-M: enrolamiento ────────────────────────────────────────

export async function createEnrollment({ subjectId, accountLabel }, issuer) {
  if (!subjectId || !accountLabel) throw new EngineError(400, 'VALIDATION_ERROR');
  const active = await pool.query('SELECT 1 FROM mfa.factors WHERE subject_id = $1', [subjectId]);
  if (active.rowCount) throw new EngineError(409, 'FACTOR_ALREADY_ACTIVE');

  // Un solo enrolamiento pendiente por usuario: empezar de nuevo invalida el anterior
  await pool.query('DELETE FROM mfa.enrollments WHERE subject_id = $1', [subjectId]);

  const secret = crypto.randomBytes(20); // 160 bits, tamaño recomendado para HMAC-SHA1
  const secretB32 = base32Encode(secret);
  const enrollmentId = newId('enr');
  const factorId = newId('fct');
  const expiresAt = new Date(Date.now() + ENROLLMENT_TTL_MS);
  await pool.query(
    'INSERT INTO mfa.enrollments (enrollment_id, subject_id, factor_id, secret_enc, expires_at) VALUES ($1, $2, $3, $4, $5)',
    [enrollmentId, subjectId, factorId, encryptSecret(secret), expiresAt],
  );
  return {
    enrollmentId,
    factorId,
    provisioningUri: provisioningUri({ issuer, account: accountLabel, secretB32 }),
    manualEntry: { issuer, account: accountLabel, secret: secretB32, algorithm: ALGORITHM, digits: DIGITS, period: PERIOD },
    expiresAt: expiresAt.toISOString(),
  };
}

export async function confirmEnrollment(enrollmentId, { subjectId, code }) {
  const { rows } = await pool.query('SELECT * FROM mfa.enrollments WHERE enrollment_id = $1 AND subject_id = $2', [enrollmentId, subjectId]);
  const e = rows[0];
  if (!e) throw new EngineError(404, 'NOT_FOUND');
  if (e.expires_at.getTime() <= Date.now()) throw new EngineError(410, 'ENROLLMENT_EXPIRED');
  await checkLock(subjectId);

  const normalized = String(code ?? '').replace(/\s+/g, '');
  const hit = /^\d{6}$/.test(normalized) ? matchStep(decryptSecret(e.secret_enc), normalized) : null;
  if (!hit) return { valid: false, reason: 'INVALID_CODE', remainingAttempts: await registerFailure(subjectId) };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const del = await client.query('DELETE FROM mfa.enrollments WHERE enrollment_id = $1', [enrollmentId]);
    if (!del.rowCount) throw new EngineError(404, 'NOT_FOUND'); // confirmado en paralelo
    const ins = await client.query(
      `INSERT INTO mfa.factors (factor_id, subject_id, secret_enc, last_used_step) VALUES ($1, $2, $3, $4)
       ON CONFLICT (subject_id) DO NOTHING RETURNING activated_at`,
      [e.factor_id, subjectId, e.secret_enc, hit.step],
    );
    if (!ins.rowCount) throw new EngineError(409, 'FACTOR_ALREADY_ACTIVE');
    const recoveryCodes = await newRecoveryCodes(client, subjectId);
    await client.query('COMMIT');
    await clearFailures(subjectId);
    return { valid: true, factorId: e.factor_id, activatedAt: ins.rows[0].activated_at.toISOString(), recoveryCodes };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteEnrollment(enrollmentId, subjectId) {
  await pool.query('DELETE FROM mfa.enrollments WHERE enrollment_id = $1 AND subject_id = $2', [enrollmentId, subjectId]);
}

// ── EP-M: verificación ────────────────────────────────────────

export async function verify({ subjectId, code, correlationId }) {
  const { rows } = await pool.query('SELECT * FROM mfa.factors WHERE subject_id = $1', [subjectId]);
  const f = rows[0];
  if (!f) throw new EngineError(404, 'NO_ACTIVE_FACTOR');
  await checkLock(subjectId);

  const normalized = String(code ?? '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(normalized)) return { valid: false, reason: 'MALFORMED', remainingAttempts: await registerFailure(subjectId) };
  const hit = matchStep(decryptSecret(f.secret_enc), normalized);
  if (!hit) return { valid: false, reason: 'INVALID_CODE', remainingAttempts: await registerFailure(subjectId) };

  // Antirreplay: el mismo reto no se verifica dos veces…
  if (correlationId) {
    const c = await pool.query('INSERT INTO mfa.used_correlations (correlation_id) VALUES ($1) ON CONFLICT DO NOTHING', [correlationId]);
    if (!c.rowCount) return { valid: false, reason: 'REPLAYED', remainingAttempts: await registerFailure(subjectId) };
  }
  // …y un código solo vale si su paso es posterior al último aceptado (actualización atómica)
  const upd = await pool.query(
    'UPDATE mfa.factors SET last_used_step = $2, last_used_at = now() WHERE subject_id = $1 AND last_used_step < $2',
    [subjectId, hit.step],
  );
  if (!upd.rowCount) return { valid: false, reason: 'REPLAYED', remainingAttempts: await registerFailure(subjectId) };

  await clearFailures(subjectId);
  return { valid: true, factorId: f.factor_id, matchedStep: hit.step, driftSteps: hit.drift, driftWarning: false };
}

export async function verifyRecovery({ subjectId, recoveryCode }) {
  const f = await pool.query('SELECT 1 FROM mfa.factors WHERE subject_id = $1', [subjectId]);
  if (!f.rowCount) throw new EngineError(404, 'NO_ACTIVE_FACTOR');
  await checkLock(subjectId);

  const upd = await pool.query(
    `UPDATE mfa.recovery_codes SET used_at = now()
     WHERE id = (SELECT id FROM mfa.recovery_codes WHERE subject_id = $1 AND code_hash = $2 AND used_at IS NULL LIMIT 1)
       AND used_at IS NULL`,
    [subjectId, hashRecoveryCode(recoveryCode ?? '')],
  );
  if (!upd.rowCount) return { valid: false, reason: 'INVALID_CODE', remainingAttempts: await registerFailure(subjectId) };
  await clearFailures(subjectId);
  return { valid: true, remaining: await remainingCodes(subjectId) };
}

async function remainingCodes(subjectId) {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM mfa.recovery_codes WHERE subject_id = $1 AND used_at IS NULL', [subjectId]);
  return rows[0].n;
}

// ── EP-M: gestión ─────────────────────────────────────────────

export async function regenerate(subjectId) {
  const f = await pool.query('SELECT 1 FROM mfa.factors WHERE subject_id = $1', [subjectId]);
  if (!f.rowCount) throw new EngineError(404, 'NO_ACTIVE_FACTOR');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const recoveryCodes = await newRecoveryCodes(client, subjectId);
    await client.query('COMMIT');
    return { recoveryCodes, generatedAt: new Date().toISOString() };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function status(subjectId) {
  const [f, pending] = await Promise.all([
    pool.query('SELECT * FROM mfa.factors WHERE subject_id = $1', [subjectId]),
    pool.query('SELECT enrollment_id, expires_at FROM mfa.enrollments WHERE subject_id = $1 AND expires_at > now() ORDER BY created_at DESC LIMIT 1', [subjectId]),
  ]);
  const factor = f.rows[0];
  return {
    enabled: !!factor,
    factors: factor
      ? [{
          factorId: factor.factor_id,
          type: 'TOTP',
          status: 'ACTIVE',
          activatedAt: factor.activated_at.toISOString(),
          lastUsedAt: factor.last_used_at ? factor.last_used_at.toISOString() : null,
        }]
      : [],
    recoveryCodesRemaining: factor ? await remainingCodes(subjectId) : 0,
    pendingEnrollment: pending.rows[0]
      ? { enrollmentId: pending.rows[0].enrollment_id, expiresAt: pending.rows[0].expires_at.toISOString() }
      : null,
  };
}

export async function deleteFactors(subjectId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const t of ['factors', 'recovery_codes', 'enrollments', 'failures', 'locks']) {
      await client.query(`DELETE FROM mfa.${t} WHERE subject_id = $1`, [subjectId]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
