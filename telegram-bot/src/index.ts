import { env } from './config/env';
import { CallbackStore, CoreClient, StateStore } from './contracts';
import { MockCoreClient } from './mocks/mock-core.client';
import { MemoryCallbackStore, MemoryStateStore } from './state/memory-stores';

export * from './contracts';

export interface BackServices {
  core: CoreClient;
  state: StateStore;
  callbacks: CallbackStore;
}

/**
 * Inicializa los servicios de infraestructura del microservicio
 * (cliente del core y almacenes de estado y callbacks).
 */
export function createBackServices(): BackServices {
  if (!env.USE_MOCK_CORE) {
    throw new Error('El modo real (USE_MOCK_CORE=false) aún no está implementado. Usa USE_MOCK_CORE=true.');
  }

  const core: CoreClient = new MockCoreClient();
  const state: StateStore = new MemoryStateStore();
  const callbacks: CallbackStore = new MemoryCallbackStore();
  return { core, state, callbacks };
}
