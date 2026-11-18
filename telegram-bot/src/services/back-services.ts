import { env } from '../config/env';
import { CoreClient, StateStore, CallbackStore } from '../contracts';
import { MockCoreClient } from '../mocks/mock-core.client';
import { MemoryStateStore, MemoryCallbackStore } from '../state/memory-stores';

export interface BackServices {
  core: CoreClient;
  state: StateStore;
  callbacks: CallbackStore;
}

/**
 * Crea o recupera los servicios del backend según el entorno.
 */
export function createBackServices(): BackServices {
  if (env.USE_MOCK_CORE) {
    return {
      core: new MockCoreClient(),
      state: new MemoryStateStore(),
      callbacks: new MemoryCallbackStore(),
    };
  }

  throw new Error('Configura USE_MOCK_CORE=true');
}