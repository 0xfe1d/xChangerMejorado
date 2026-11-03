import { AsyncLocalStorage } from 'async_hooks';

// Contexto por petición para propagar X-Request-Id a log y eventos sin pasarlo a mano.
interface RequestContext {
  requestId?: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function currentRequestId(): string | undefined {
  return requestContext.getStore()?.requestId;
}
