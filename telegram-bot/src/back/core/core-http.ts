import crypto from 'crypto';
import { ulid } from 'ulid';
import { CoreApiError, RequestMeta } from '../../contracts';
import { parseCoreError, ServiceAuthManager } from './service-auth';
import { ChannelSessionManager } from './session-manager';

const DEFAULT_TIMEOUT_MS = 10_000;

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';
export type QueryParams = Record<string, string | number | boolean | undefined>;

export interface HttpRequestOptions {
  query?: QueryParams;
  body?: unknown;
  idempotent?: boolean;
  meta?: RequestMeta;
}

export interface HttpResponse<T> {
  status: number;
  headers: Headers;
  data: T;
}

export interface CoreHttpConfig {
  coreApiUrl: string;
  serviceAuth: ServiceAuthManager;
  sessionManager: ChannelSessionManager;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

type AuthMode =
  | { kind: 'public' }
  | { kind: 'service' }
  | { kind: 'user'; externalUserId: string };

function buildQueryString(query?: QueryParams): string {
  if (!query) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

function buildIdempotencyKey(meta?: RequestMeta): string {
  if (meta?.updateId !== undefined && Number.isInteger(meta.updateId) && meta.updateId >= 0) {
    return `tg:${meta.updateId}`;
  }
  return crypto.randomUUID();
}

/**
 * Capa de transporte HTTP hacia el Core (`/api/v1`) (§6.2, §9.1).
 * Centraliza cabeceras comunes (`X-Request-Id`, `Idempotency-Key`, `X-Service-Authorization`,
 * `Authorization`), timeouts, reintento único ante `401` y limpieza ante revocación/bloqueo.
 */
export class CoreHttpTransport {
  private readonly baseUrl: string;
  private readonly serviceAuth: ServiceAuthManager;
  private readonly sessionManager: ChannelSessionManager;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(config: CoreHttpConfig) {
    this.baseUrl = config.coreApiUrl.replace(/\/+$/, '');
    this.serviceAuth = config.serviceAuth;
    this.sessionManager = config.sessionManager;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  publicRequest<T>(method: HttpMethod, path: string, opts: HttpRequestOptions = {}) {
    return this.send<T>(method, path, { kind: 'public' }, opts);
  }

  serviceRequest<T>(method: HttpMethod, path: string, opts: HttpRequestOptions = {}) {
    return this.send<T>(method, path, { kind: 'service' }, opts);
  }

  userRequest<T>(
    externalUserId: string,
    method: HttpMethod,
    path: string,
    opts: HttpRequestOptions = {},
  ) {
    return this.send<T>(method, path, { kind: 'user', externalUserId }, opts);
  }

  private async send<T>(
    method: HttpMethod,
    path: string,
    auth: AuthMode,
    opts: HttpRequestOptions,
  ): Promise<HttpResponse<T>> {
    const requestId = ulid();
    const idempotencyKey = opts.idempotent ? buildIdempotencyKey(opts.meta) : undefined;
    const url = `${this.baseUrl}${path}${buildQueryString(opts.query)}`;

    let serviceRetried = false;
    let userRetried = false;
    let overrideAccessToken: string | undefined;

    while (true) {
      let currentAccessToken: string | undefined;
      const headers: Record<string, string> = {
        'Accept-Language': 'es',
        'X-Request-Id': requestId,
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      };

      if (auth.kind !== 'public') {
        headers['X-Service-Authorization'] = `Bearer ${await this.serviceAuth.getToken(requestId)}`;
      }

      if (auth.kind === 'user') {
        currentAccessToken =
          overrideAccessToken ??
          (await this.sessionManager.getValidAccessToken(auth.externalUserId, requestId));
        overrideAccessToken = undefined;
        headers['Authorization'] = `Bearer ${currentAccessToken}`;
      }

      try {
        return await this.execute<T>(url, method, headers, opts.body, requestId);
      } catch (err) {
        if (!(err instanceof CoreApiError)) throw err;

        if (
          err.status === 401 &&
          err.code === 'SERVICE_UNAUTHORIZED' &&
          auth.kind !== 'public' &&
          !serviceRetried
        ) {
          serviceRetried = true;
          this.serviceAuth.invalidate();
          continue;
        }

        if (
          err.status === 401 &&
          err.code === 'TOKEN_EXPIRED' &&
          auth.kind === 'user' &&
          currentAccessToken &&
          !userRetried
        ) {
          userRetried = true;
          overrideAccessToken = await this.sessionManager.refreshOnExpired(
            auth.externalUserId,
            currentAccessToken,
            requestId,
          );
          continue;
        }

        if (
          auth.kind === 'user' &&
          (err.code === 'SESSION_REVOKED' || err.code === 'ACCOUNT_BLOCKED')
        ) {
          await this.sessionManager.clearLocalSession(auth.externalUserId);
        }

        throw err;
      }
    }
  }

  private async execute<T>(
    url: string,
    method: HttpMethod,
    headers: Record<string, string>,
    body: unknown,
    requestId: string,
  ): Promise<HttpResponse<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const hasBody = body !== undefined;
      const res = await this.fetchImpl(url, {
        method,
        headers: hasBody ? { 'Content-Type': 'application/json', ...headers } : headers,
        ...(hasBody ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });

      if (!res.ok) throw await parseCoreError(res, requestId);
      if (res.status === 204) {
        return { status: res.status, headers: res.headers, data: undefined as T };
      }

      const raw = await res.text();
      return {
        status: res.status,
        headers: res.headers,
        data: (raw ? JSON.parse(raw) : undefined) as T,
      };
    } catch (err) {
      if (err instanceof CoreApiError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new CoreApiError(504, 'CORE_TIMEOUT', 'El servidor tardó demasiado en responder', undefined, requestId);
      }
      throw new CoreApiError(503, 'CORE_UNAVAILABLE', 'No se pudo conectar con el servidor', undefined, requestId);
    } finally {
      clearTimeout(timer);
    }
  }
}
