// SSR: API_URL (privada). Cliente: PUBLIC_API_URL (expuesta por Astro al browser).
const BASE_URL =
  (import.meta.env.API_URL as string | undefined) ??
  (import.meta.env.PUBLIC_API_URL as string | undefined) ??
  '';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
}

/**
 * Wrapper de fetch centralizado.
 * - credentials: 'include' garantiza que las cookies HttpOnly viajen en cada petición.
 * - Lanza ApiError con el status y el cuerpo de error para manejo uniforme en UI.
 */
// ── Renovación de sesión (solo navegador) ─────────────────────
// La cookie refresh_token solo viaja a /api/auth/refresh (RF-AUT-11), así que
// el SSR no puede renovar la sesión: lo hace el navegador al recibir un 401.

/** Códigos de 401 que indican sesión caducada o ausente (no credenciales erróneas). */
const SESSION_CODES = new Set(['TOKEN_EXPIRED', 'UNAUTHORIZED', 'INVALID_TOKEN']);
/** Endpoints cuyo 401 nunca debe disparar una renovación. */
const NO_REFRESH = ['/auth/login', '/auth/refresh', '/auth/logout', '/auth/mfa/challenge', '/auth/register', '/auth/verify-otp', '/auth/reauthenticate'];

let refreshing: Promise<boolean> | null = null;

/** Pide un access token nuevo con la cookie de refresco. Una sola petición en vuelo. */
export function refreshSession(): Promise<boolean> {
  if (!refreshing) {
    refreshing = fetch(`${BASE_URL}/api/auth/refresh`, { method: 'POST', credentials: 'include' })
      .then((r) => r.ok)
      .catch(() => false)
      .finally(() => { refreshing = null; });
  }
  return refreshing;
}

export async function apiFetch<T = unknown>(
  path: string,
  options: RequestOptions = {},
  retried = false,
): Promise<T> {
  const { body, headers, ...rest } = options;

  const res = await fetch(`${BASE_URL}/api${path}`, {
    ...rest,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  if (!res.ok) {
    let data: unknown;
    try { data = await res.json(); } catch { /* texto plano */ }

    const code = (data as { code?: string } | undefined)?.code;
    if (
      res.status === 401 && !retried && typeof window !== 'undefined' &&
      SESSION_CODES.has(code ?? '') && !NO_REFRESH.some((p) => path.startsWith(p)) &&
      (await refreshSession())
    ) {
      return apiFetch<T>(path, options, true);
    }

    const message =
      (data as { error?: string } | undefined)?.error ??
      `Error ${res.status}`;
    throw new ApiError(res.status, message, data);
  }

  // 204 No Content
  if (res.status === 204) return undefined as T;

  return res.json() as Promise<T>;
}

// ── Helpers semánticos ────────────────────────────────────────

function createApiInstance(cookieHeader?: string) {
  const extra: HeadersInit = cookieHeader ? { Cookie: cookieHeader } : {};
  return {
    get: <T>(path: string, init?: RequestOptions) =>
      apiFetch<T>(path, { method: 'GET', ...init, headers: { ...extra, ...init?.headers } }),

    post: <T>(path: string, body?: unknown, init?: RequestOptions) =>
      apiFetch<T>(path, { method: 'POST', body, ...init, headers: { ...extra, ...init?.headers } }),

    patch: <T>(path: string, body?: unknown, init?: RequestOptions) =>
      apiFetch<T>(path, { method: 'PATCH', body, ...init, headers: { ...extra, ...init?.headers } }),

    delete: <T>(path: string, init?: RequestOptions) =>
      apiFetch<T>(path, { method: 'DELETE', ...init, headers: { ...extra, ...init?.headers } }),
  };
}

/** Para uso cliente (browser): credentials:'include' gestiona las cookies. */
export const api = createApiInstance();

/** Para uso SSR (Astro frontmatter): reenvía las cookies del request entrante al backend. */
export function serverApi(request: Request) {
  return createApiInstance(request.headers.get('cookie') ?? undefined);
}

// ── Tipos de respuesta compartidos ───────────────────────────

export interface UserMe {
  id: string;
  email: string;
  role: 'ESTUDIANTE' | 'EMBAJADOR' | 'PROPIETARIO' | 'BLOQUEADO';
}

export interface Carrera {
  id: string;
  nombre: string;
}

export interface Curso {
  id: string;
  nombre: string;
  carreraId: string;
}
