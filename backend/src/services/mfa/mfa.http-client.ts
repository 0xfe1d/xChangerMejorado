import { env } from '../../config/env';
import { AppError } from '../../middleware/errorHandler';
import { CircuitBreaker } from '../../utils/circuit-breaker';
import { currentRequestId } from '../../utils/request-context';
import { signServiceToken } from '../service-auth.service';
import {
  MfaGateway, EnrollmentCreated, ConfirmResult, VerifyResult, RecoveryResult, FactorsStatus,
} from './mfa.gateway';

export const MFA_AUDIENCE = 'mfa-service';

const unavailable = () =>
  new AppError(503, 'El servicio de verificación en dos pasos no está disponible. Inténtalo en unos minutos.', 'MFA_SERVICE_UNAVAILABLE');

interface CallOptions {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  body?: unknown;
  /** Solo las lecturas se reintentan una vez (§10.3). */
  retry?: boolean;
}

interface RawResponse {
  status: number;
  body: any;
  headers: Headers;
}

/**
 * Cliente HTTP del mfa-service. Credencial: JWT de servicio del core
 * (aud=mfa-service, scope mfa:manage) que el mfa-service valida con EP-C-02.
 */
export class HttpMfaGateway implements MfaGateway {
  readonly breaker = new CircuitBreaker(5, 30_000);
  private cachedToken: { value: string; exp: number } | null = null;

  constructor(
    private readonly baseUrl = env.MFA_SERVICE_URL,
    private readonly timeoutMs = env.MFA_TIMEOUT_MS,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async token(): Promise<string> {
    const now = Date.now();
    if (!this.cachedToken || this.cachedToken.exp - now < 60_000) {
      this.cachedToken = { value: await signServiceToken('xchanger-core', MFA_AUDIENCE, ['mfa:manage']), exp: now + 600_000 };
    }
    return this.cachedToken.value;
  }

  private async rawCall(opts: CallOptions): Promise<RawResponse> {
    if (!this.breaker.canRequest()) throw unavailable();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${opts.path}`, {
        method: opts.method,
        headers: {
          Authorization: `Bearer ${await this.token()}`,
          'Content-Type': 'application/json',
          ...(currentRequestId() ? { 'X-Request-Id': currentRequestId()! } : {}),
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: controller.signal,
      });
      if (res.status >= 500) {
        this.breaker.failure();
        throw unavailable();
      }
      this.breaker.success();
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
    } catch (err) {
      if (err instanceof AppError) throw err;
      this.breaker.failure(); // red caída, timeout o respuesta ilegible
      throw unavailable();
    } finally {
      clearTimeout(timer);
    }
  }

  private async call(opts: CallOptions): Promise<RawResponse> {
    try {
      return await this.rawCall(opts);
    } catch (err) {
      if (opts.retry && err instanceof AppError && err.code === 'MFA_SERVICE_UNAVAILABLE' && this.breaker.canRequest()) {
        return this.rawCall(opts);
      }
      throw err;
    }
  }

  /** Traduce los errores del contrato EP-M a errores del core. */
  private mapError(res: RawResponse, context: string): never {
    const code = res.body?.code as string | undefined;
    if (res.status === 423) {
      const retryAfter = Number(res.body?.retryAfter ?? res.body?.details?.retryAfter ?? res.headers.get('retry-after') ?? 900);
      throw new AppError(423, 'Demasiados códigos incorrectos. La verificación está bloqueada temporalmente.', 'MFA_LOCKED', { retryAfter });
    }
    if (res.status === 409) throw new AppError(409, 'La verificación en dos pasos ya está activada', 'MFA_ALREADY_ENABLED');
    if (res.status === 410) throw new AppError(410, 'El enrolamiento ha caducado. Vuelve a empezar.', 'ENROLLMENT_EXPIRED');
    if (res.status === 404) {
      throw new AppError(404, context === 'factor' ? 'No hay un segundo factor activo' : 'Enrolamiento no encontrado',
        context === 'factor' ? 'MFA_NOT_ENABLED' : 'NOT_FOUND');
    }
    if (res.status === 400) throw new AppError(400, 'Código con formato inválido', 'MFA_INVALID_CODE', code ? { reason: code } : undefined);
    // 401/403 del mfa-service = credencial del core mal configurada: se trata como indisponible
    console.error(`[mfa] respuesta inesperada ${res.status} en ${context}`, code);
    throw unavailable();
  }

  async createEnrollment(input: { subjectId: string; accountLabel: string; confirmUrl?: string; digits?: 6 | 8 }): Promise<EnrollmentCreated> {
    const res = await this.call({ method: 'POST', path: '/v1/enrollments', body: input });
    if (res.status === 201 || res.status === 200) return res.body as EnrollmentCreated;
    return this.mapError(res, 'enrollment');
  }

  async confirmEnrollment(enrollmentId: string, input: { subjectId: string; code: string }): Promise<ConfirmResult> {
    const res = await this.call({ method: 'POST', path: `/v1/enrollments/${encodeURIComponent(enrollmentId)}/confirm`, body: input });
    if (res.status === 200) {
      if (res.body?.valid === false) return res.body as ConfirmResult;
      return { valid: true, ...res.body } as ConfirmResult;
    }
    return this.mapError(res, 'enrollment');
  }

  async deleteEnrollment(enrollmentId: string, subjectId: string): Promise<void> {
    const res = await this.call({ method: 'DELETE', path: `/v1/enrollments/${encodeURIComponent(enrollmentId)}?subjectId=${encodeURIComponent(subjectId)}` });
    if (res.status === 204 || res.status === 200) return;
    this.mapError(res, 'enrollment');
  }

  async verify(input: Parameters<MfaGateway['verify']>[0]): Promise<VerifyResult> {
    const res = await this.call({ method: 'POST', path: '/v1/verify', body: input });
    if (res.status === 200) return res.body as VerifyResult;
    return this.mapError(res, 'factor');
  }

  async verifyRecovery(input: Parameters<MfaGateway['verifyRecovery']>[0]): Promise<RecoveryResult> {
    const res = await this.call({ method: 'POST', path: '/v1/recovery-codes/verify', body: input });
    if (res.status === 200) return res.body as RecoveryResult;
    return this.mapError(res, 'factor');
  }

  async regenerateRecoveryCodes(subjectId: string) {
    const res = await this.call({ method: 'POST', path: `/v1/subjects/${encodeURIComponent(subjectId)}/recovery-codes`, body: {} });
    if (res.status === 200) return res.body as { recoveryCodes: string[]; generatedAt: string };
    return this.mapError(res, 'factor');
  }

  async getFactors(subjectId: string): Promise<FactorsStatus> {
    const res = await this.call({ method: 'GET', path: `/v1/subjects/${encodeURIComponent(subjectId)}/factors`, retry: true });
    if (res.status === 200) return res.body as FactorsStatus;
    return this.mapError(res, 'factor');
  }

  async deleteFactors(subjectId: string, input: { reason: 'USER_DISABLED' | 'ADMIN_RESET' | 'ACCOUNT_DELETED'; actorId: string }): Promise<void> {
    const res = await this.call({ method: 'DELETE', path: `/v1/subjects/${encodeURIComponent(subjectId)}/factors`, body: input });
    if (res.status === 204 || res.status === 200) return;
    this.mapError(res, 'factor');
  }

  async health(): Promise<'up' | 'down' | 'degraded'> {
    try {
      const res = await this.rawCall({ method: 'GET', path: '/v1/health' });
      return res.status === 200 ? (res.body?.status === 'ok' || res.body?.status === 'up' ? 'up' : 'degraded') : 'degraded';
    } catch {
      return 'down';
    }
  }
}

// ── Punto de inyección ────────────────────────────────────────
let gateway: MfaGateway | null = null;

export function getMfaGateway(): MfaGateway {
  if (!gateway) gateway = new HttpMfaGateway();
  return gateway;
}

/** Sustituye el gateway (tests de integración). */
export function setMfaGateway(g: MfaGateway | null): void {
  gateway = g;
}
