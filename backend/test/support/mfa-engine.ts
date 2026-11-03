import crypto from 'crypto';
import { base32Encode, currentStep, totp } from './totp';

/**
 * Simulación en memoria del mfa-service que respeta el contrato EP-M (§10.2):
 * ventana ±1, antirreplay por paso, 5 fallos → bloqueo 15 min, códigos de
 * recuperación de un solo uso. La usan el gateway falso (integración) y el
 * stub HTTP (E2E). NO es el mfa-service real (queda fuera del core).
 */

export class MfaEngineError extends Error {
  constructor(public status: number, public code: string, public retryAfter?: number) {
    super(code);
  }
}

interface Factor {
  factorId: string;
  subjectId: string;
  secret: Buffer;
  status: 'PENDING' | 'ACTIVE';
  lastUsedStep: number;
  activatedAt: string | null;
  lastUsedAt: string | null;
  recovery: Array<{ code: string; used: boolean }>;
}

interface Enrollment {
  enrollmentId: string;
  subjectId: string;
  factor: Factor;
  expiresAt: number;
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const genRecovery = () => {
  const part = () => Array.from({ length: 5 }, () => CROCKFORD[crypto.randomInt(0, 32)]).join('');
  return `${part()}-${part()}`;
};
const normRecovery = (c: string) => c.toUpperCase().replace(/-/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');

export class MfaEngine {
  factors = new Map<string, Factor>(); // subjectId → factor activo
  enrollments = new Map<string, Enrollment>();
  failures = new Map<string, number[]>(); // subjectId → timestamps de fallo
  lockedUntil = new Map<string, number>();
  usedCorrelations = new Set<string>();
  /** Reloj inyectable para probar ventanas de tiempo. */
  now: () => number = () => Date.now();
  down = false;

  reset(): void {
    this.factors.clear();
    this.enrollments.clear();
    this.failures.clear();
    this.lockedUntil.clear();
    this.usedCorrelations.clear();
    this.down = false;
  }

  private guard(): void {
    if (this.down) throw new MfaEngineError(503, 'UNAVAILABLE');
  }

  private checkLock(subjectId: string): void {
    const until = this.lockedUntil.get(subjectId) ?? 0;
    if (until > this.now()) throw new MfaEngineError(423, 'LOCKED', Math.ceil((until - this.now()) / 1000));
  }

  private fail(subjectId: string): number {
    const t = this.now();
    const recent = (this.failures.get(subjectId) ?? []).filter((x) => t - x < 5 * 60_000);
    recent.push(t);
    this.failures.set(subjectId, recent);
    if (recent.length >= 5) {
      this.lockedUntil.set(subjectId, t + 15 * 60_000);
      this.failures.set(subjectId, []);
    }
    return Math.max(0, 5 - recent.length);
  }

  /** Devuelve el paso que coincide dentro de la ventana ±1, o null. */
  private match(f: Factor, code: string): number | null {
    const t = currentStep(this.now() / 1000);
    let hit: number | null = null;
    for (const s of [t - 1, t, t + 1]) {
      const cand = totp(f.secret, s * 30);
      // Comparación en tiempo constante y sin cortocircuito (§7.2.5)
      if (code.length === cand.length && crypto.timingSafeEqual(Buffer.from(code), Buffer.from(cand))) hit = s;
    }
    return hit;
  }

  createEnrollment(input: { subjectId: string; accountLabel: string }) {
    this.guard();
    if (this.factors.has(input.subjectId)) throw new MfaEngineError(409, 'FACTOR_ALREADY_ACTIVE');
    for (const [id, e] of this.enrollments) if (e.subjectId === input.subjectId) this.enrollments.delete(id);
    const secret = crypto.randomBytes(32);
    const factor: Factor = {
      factorId: `fct_${crypto.randomUUID()}`, subjectId: input.subjectId, secret, status: 'PENDING',
      lastUsedStep: -1, activatedAt: null, lastUsedAt: null, recovery: [],
    };
    const enrollmentId = `enr_${crypto.randomUUID().replace(/-/g, '')}`;
    const expiresAt = this.now() + 10 * 60_000;
    this.enrollments.set(enrollmentId, { enrollmentId, subjectId: input.subjectId, factor, expiresAt });
    const sec = base32Encode(secret);
    return {
      enrollmentId,
      factorId: factor.factorId,
      provisioningUri: `xchanger-otp://v1/enroll?p=stub&s=stub&k=test`,
      manualEntry: { issuer: 'xChanger UC', account: input.accountLabel, secret: sec, algorithm: 'SHA256', digits: 6, period: 30 },
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  confirmEnrollment(enrollmentId: string, input: { subjectId: string; code: string }) {
    this.guard();
    const e = this.enrollments.get(enrollmentId);
    if (!e || e.subjectId !== input.subjectId) throw new MfaEngineError(404, 'NOT_FOUND');
    if (e.expiresAt <= this.now()) throw new MfaEngineError(410, 'ENROLLMENT_EXPIRED');
    this.checkLock(input.subjectId);
    const step = this.match(e.factor, input.code);
    if (step === null) return { valid: false as const, reason: 'INVALID_CODE', remainingAttempts: this.fail(input.subjectId) };
    const f = e.factor;
    f.status = 'ACTIVE';
    f.lastUsedStep = step;
    f.activatedAt = new Date(this.now()).toISOString();
    f.recovery = Array.from({ length: 10 }, () => ({ code: genRecovery(), used: false }));
    this.factors.set(input.subjectId, f);
    this.enrollments.delete(enrollmentId);
    return { valid: true as const, factorId: f.factorId, activatedAt: f.activatedAt, recoveryCodes: f.recovery.map((r) => r.code) };
  }

  deleteEnrollment(enrollmentId: string, subjectId: string) {
    this.guard();
    const e = this.enrollments.get(enrollmentId);
    if (e && e.subjectId === subjectId) this.enrollments.delete(enrollmentId);
  }

  verify(input: { subjectId: string; code: string; correlationId: string }) {
    this.guard();
    const f = this.factors.get(input.subjectId);
    if (!f) throw new MfaEngineError(404, 'NO_ACTIVE_FACTOR');
    this.checkLock(input.subjectId);
    if (!/^\d{6}$/.test(input.code)) return { valid: false as const, reason: 'MALFORMED', remainingAttempts: this.fail(input.subjectId) };
    const step = this.match(f, input.code);
    if (step === null) return { valid: false as const, reason: 'INVALID_CODE', remainingAttempts: this.fail(input.subjectId) };
    // Antirreplay: solo pasos estrictamente posteriores al último aceptado
    if (step <= f.lastUsedStep || this.usedCorrelations.has(input.correlationId)) {
      return { valid: false as const, reason: 'REPLAYED', remainingAttempts: this.fail(input.subjectId) };
    }
    f.lastUsedStep = step;
    f.lastUsedAt = new Date(this.now()).toISOString();
    this.usedCorrelations.add(input.correlationId);
    const drift = step - currentStep(this.now() / 1000);
    return { valid: true as const, factorId: f.factorId, matchedStep: step, driftSteps: drift, driftWarning: false };
  }

  verifyRecovery(input: { subjectId: string; recoveryCode: string }) {
    this.guard();
    const f = this.factors.get(input.subjectId);
    if (!f) throw new MfaEngineError(404, 'NO_ACTIVE_FACTOR');
    this.checkLock(input.subjectId);
    const want = normRecovery(input.recoveryCode);
    const hit = f.recovery.find((r) => !r.used && normRecovery(r.code) === want);
    if (!hit) return { valid: false as const, reason: 'INVALID_CODE', remainingAttempts: this.fail(input.subjectId) };
    hit.used = true;
    return { valid: true as const, remaining: f.recovery.filter((r) => !r.used).length };
  }

  regenerate(subjectId: string) {
    this.guard();
    const f = this.factors.get(subjectId);
    if (!f) throw new MfaEngineError(404, 'NO_ACTIVE_FACTOR');
    f.recovery = Array.from({ length: 10 }, () => ({ code: genRecovery(), used: false }));
    return { recoveryCodes: f.recovery.map((r) => r.code), generatedAt: new Date(this.now()).toISOString() };
  }

  status(subjectId: string) {
    this.guard();
    const f = this.factors.get(subjectId);
    const pending = [...this.enrollments.values()].find((e) => e.subjectId === subjectId && e.expiresAt > this.now());
    return {
      enabled: !!f,
      factors: f ? [{ factorId: f.factorId, type: 'XOTP' as const, status: 'ACTIVE', activatedAt: f.activatedAt, lastUsedAt: f.lastUsedAt }] : [],
      recoveryCodesRemaining: f ? f.recovery.filter((r) => !r.used).length : 0,
      pendingEnrollment: pending ? { enrollmentId: pending.enrollmentId, expiresAt: new Date(pending.expiresAt).toISOString() } : null,
    };
  }

  deleteFactors(subjectId: string) {
    this.guard();
    this.factors.delete(subjectId);
  }

  /** Adelanta el reloj simulado (para obtener un paso TOTP posterior sin esperar 30 s). */
  advance(ms: number): void {
    const base = this.now;
    this.now = () => base() + ms;
  }

  /** Utilidad de test: secreto Base32 del factor activo o pendiente de un usuario. */
  secretOf(subjectId: string): Buffer | undefined {
    return this.factors.get(subjectId)?.secret ?? [...this.enrollments.values()].find((e) => e.subjectId === subjectId)?.factor.secret;
  }

  /** Código válido en el paso siguiente al último usado (evita REPLAYED en tests seguidos). */
  nextCode(subjectId: string): string {
    const f = this.factors.get(subjectId);
    const secret = this.secretOf(subjectId);
    if (!secret) throw new Error('sin factor');
    const t = currentStep(this.now() / 1000);
    const step = f && f.lastUsedStep >= t ? f.lastUsedStep + 1 : t;
    if (step > t + 1) throw new Error('ventana agotada: avanza el reloj del motor');
    return totp(secret, step * 30);
  }
}
