import { AppError } from '../../src/middleware/errorHandler';
import { MfaGateway } from '../../src/services/mfa/mfa.gateway';
import { MfaEngine, MfaEngineError } from './mfa-engine';

/** Adapta el motor en memoria a la interfaz MfaGateway, con los mismos errores que el cliente HTTP. */
export class FakeMfaGateway implements MfaGateway {
  constructor(public readonly engine = new MfaEngine()) {}

  private run<T>(fn: () => T): Promise<T> {
    try {
      return Promise.resolve(fn());
    } catch (err) {
      if (err instanceof MfaEngineError) {
        if (err.status === 503) return Promise.reject(new AppError(503, 'MFA caído', 'MFA_SERVICE_UNAVAILABLE'));
        if (err.status === 423) return Promise.reject(new AppError(423, 'Bloqueado', 'MFA_LOCKED', { retryAfter: err.retryAfter }));
        if (err.status === 409) return Promise.reject(new AppError(409, 'Ya activo', 'MFA_ALREADY_ENABLED'));
        if (err.status === 410) return Promise.reject(new AppError(410, 'Caducado', 'ENROLLMENT_EXPIRED'));
        if (err.status === 404) return Promise.reject(new AppError(404, 'No encontrado', err.code === 'NO_ACTIVE_FACTOR' ? 'MFA_NOT_ENABLED' : 'NOT_FOUND'));
      }
      return Promise.reject(err);
    }
  }

  createEnrollment(i: { subjectId: string; accountLabel: string }) { return this.run(() => this.engine.createEnrollment(i)); }
  confirmEnrollment(id: string, i: { subjectId: string; code: string }) { return this.run(() => this.engine.confirmEnrollment(id, i)); }
  deleteEnrollment(id: string, s: string) { return this.run(() => this.engine.deleteEnrollment(id, s)); }
  verify(i: { subjectId: string; code: string; correlationId: string }) { return this.run(() => this.engine.verify(i)); }
  verifyRecovery(i: { subjectId: string; recoveryCode: string }) { return this.run(() => this.engine.verifyRecovery(i)); }
  regenerateRecoveryCodes(s: string) { return this.run(() => this.engine.regenerate(s)); }
  getFactors(s: string) { return this.run(() => this.engine.status(s)); }
  deleteFactors(s: string) { return this.run(() => this.engine.deleteFactors(s)); }
  health() { return Promise.resolve(this.engine.down ? ('down' as const) : ('up' as const)); }
}
