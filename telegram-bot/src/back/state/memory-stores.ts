import crypto from 'crypto';
import { CallbackPayload, CallbackStore, ConversationState, StateStore } from '../../contracts';

const DEFAULT_STATE_TTL_SEC = 15 * 60;
const DEFAULT_CB_TTL_SEC = 24 * 60 * 60;

interface Entry<T> {
  value: T;
  expiresAt: number;
}

/**
 * Implementación en memoria de StateStore (para desarrollo sin Redis).
 * En producción/Back real se reemplaza por Redis con TTL de 15 min (§6.2).
 */
export class MemoryStateStore implements StateStore {
  private readonly store = new Map<string, Entry<ConversationState>>();

  async get(chatId: string): Promise<ConversationState | null> {
    const entry = this.store.get(chatId);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(chatId);
      return null;
    }
    return entry.value;
  }

  async set(chatId: string, state: ConversationState, ttlSec = DEFAULT_STATE_TTL_SEC): Promise<void> {
    this.store.set(chatId, { value: state, expiresAt: Date.now() + ttlSec * 1000 });
  }

  async clear(chatId: string): Promise<void> {
    this.store.delete(chatId);
  }
}

/**
 * Implementación en memoria de CallbackStore (para desarrollo sin Redis).
 * Telegram admite máximo 64 bytes en callback_data; aquí devolvemos `cb:<16 chars>`.
 */
export class MemoryCallbackStore implements CallbackStore {
  private readonly store = new Map<string, Entry<CallbackPayload>>();

  async encode(payload: CallbackPayload, ttlSec = DEFAULT_CB_TTL_SEC): Promise<string> {
    const key = `cb:${crypto.randomBytes(8).toString('hex')}`;
    this.store.set(key, { value: payload, expiresAt: Date.now() + ttlSec * 1000 });
    return key;
  }

  async decode(key: string): Promise<CallbackPayload | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }
}

