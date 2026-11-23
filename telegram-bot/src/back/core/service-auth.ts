import { ulid } from 'ulid';
import { CoreApiError } from '../../contracts';

const DEFAULT_SCOPE = 'channel:telegram';
const DEFAULT_REFRESH_THRESHOLD_SEC = 60;

interface CoreErrorPayload {
  error?: string;
  code?: string;
  details?: Record<string, unknown>;
  requestId?: string;
}

/**
 * Convierte cualquier respuesta no-2xx del Core en un `CoreApiError` homogéneo (§5.10).
 */
export async function parseCoreError(
  response: Response,
  fallbackRequestId?: string,
): Promise<CoreApiError> {
  const payload = (await response.json().catch(() => null)) as CoreErrorPayload | null;
  const code = typeof payload?.code === 'string' && payload.code ? payload.code : `HTTP_${response.status}`;
  const message =
    typeof payload?.error === 'string' && payload.error
      ? payload.error
      : `Error del Core (${response.status})`;
  const requestId =
    typeof payload?.requestId === 'string' && payload.requestId
      ? payload.requestId
      : fallbackRequestId;

  return new CoreApiError(response.status, code, message, payload?.details, requestId);
}

export interface ServiceAuthConfig {
  coreApiUrl: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
  /** Segundos de margen antes de la expiración para renovar anticipadamente (§9.2). */
  refreshThresholdSec?: number;
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
}

interface ServiceTokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  scope: string;
}

interface CachedServiceToken {
  accessToken: string;
  expiresAtMs: number;
}

/**
 * Gestiona el JWT de servicio (`X-Service-Authorization`) obtenido mediante `EP-C-01`
 * (`POST /api/v1/service-auth/token`). Cachea en memoria, renueva cuando quedan < 60 s
 * y agrupa peticiones concurrentes en una sola llamada HTTP.
 */
export class ServiceAuthManager {
  private readonly baseUrl: string;
  private readonly scope: string;
  private readonly refreshThresholdMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly nowMs: () => number;

  private cached: CachedServiceToken | null = null;
  private inFlight: Promise<string> | null = null;

  constructor(private readonly config: ServiceAuthConfig) {
    this.baseUrl = config.coreApiUrl.replace(/\/+$/, '');
    this.scope = config.scope ?? DEFAULT_SCOPE;
    this.refreshThresholdMs = (config.refreshThresholdSec ?? DEFAULT_REFRESH_THRESHOLD_SEC) * 1000;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.nowMs = config.nowMs ?? (() => Date.now());
  }

  /** Devuelve un JWT de servicio vigente o lo solicita al Core si está próximo a caducar. */
  async getToken(requestId?: string): Promise<string> {
    if (this.cached && this.cached.expiresAtMs - this.nowMs() > this.refreshThresholdMs) {
      return this.cached.accessToken;
    }

    if (!this.inFlight) {
      this.inFlight = this.fetchNewToken(requestId).finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  /** Fuerza la renovación en la próxima llamada (p. ej. tras rotación de claves del Core). */
  invalidate(): void {
    this.cached = null;
  }

  private async fetchNewToken(requestId?: string): Promise<string> {
    const reqId = requestId ?? ulid();
    const res = await this.fetchImpl(`${this.baseUrl}/service-auth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept-Language': 'es',
        'X-Request-Id': reqId,
      },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        scope: this.scope,
      }),
    });

    if (!res.ok) {
      throw await parseCoreError(res, reqId);
    }

    const body = (await res.json()) as ServiceTokenResponse;
    this.cached = {
      accessToken: body.access_token,
      expiresAtMs: this.nowMs() + body.expires_in * 1000,
    };
    return body.access_token;
  }
}
