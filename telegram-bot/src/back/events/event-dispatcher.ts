import {
  AccountBlockedEvent,
  AccountUnblockedEvent,
  BotEventHandlers,
  ChannelLinkApprovedEvent,
  ChannelLinkDeniedEvent,
  ChannelSessionRevokedEvent,
  CoreApiError,
  CoreClient,
  NotificationCreatedEvent,
  OfferMessageCreatedEvent,
  OfferStatusChangedEvent,
} from '../../contracts';
import { AcademicEntity, RedisCatalogCache } from '../core/catalog-cache';
import { ChannelSessionManager } from '../core/session-manager';
import { TelegramAccountsRepository } from '../storage/accounts.repo';
import { RedisPendingLinkStore } from '../storage/redis-stores';

/** Sobre común publicado por el outbox del Core en `xchanger:events` (§11). */
export interface CoreEventEnvelope<T = Record<string, unknown>> {
  id: string;
  type: string;
  version: number;
  occurredAt: string;
  producer: string;
  requestId?: string;
  audience: string[];
  data: T;
}

export interface BotEventDispatcherDeps {
  accountsRepo: TelegramAccountsRepository;
  sessionManager: ChannelSessionManager;
  pendingLinkStore: RedisPendingLinkStore;
  catalogCache: RedisCatalogCache;
  coreClient: Pick<CoreClient, 'exchangeLinkCode'>;
  handlers: BotEventHandlers;
}

const VALID_ACADEMIC_ENTITIES = new Set<AcademicEntity>([
  'CARRERA',
  'CURSO',
  'ASIGNATURA',
  'GRUPO',
]);

/**
 * Enruta los eventos de `xchanger:events`:
 *  1. Ejecuta reacciones de infraestructura (caché, canje automático, limpieza de sesiones).
 *  2. Filtra estrictamente por `audience` contra `telegram_accounts` (§11 Privacidad).
 *  3. Dispara el handler correspondiente en `BotEventHandlers` (`src/front/`).
 */
export class BotEventDispatcher {
  constructor(private readonly deps: BotEventDispatcherDeps) {}

  async dispatch(event: CoreEventEnvelope): Promise<void> {
    switch (event.type) {
      case 'academic.changed':
        await this.handleAcademicChanged(event.data as { entity?: string });
        return;

      case 'channel.link.approved':
        await this.handleChannelLinkApproved(event.data as unknown as ChannelLinkApprovedEvent);
        return;

      case 'channel.link.denied':
        await this.handleChannelLinkDenied(event.data as unknown as ChannelLinkDeniedEvent);
        return;

      case 'channel.session.revoked':
        await this.handleSessionRevoked(event.data as unknown as ChannelSessionRevokedEvent);
        return;

      case 'account.blocked':
        await this.handleAccountBlocked(event.data as unknown as AccountBlockedEvent);
        return;

      case 'account.unblocked':
      case 'notification.created':
      case 'offer.message.created':
      case 'offer.status.changed':
        await this.dispatchAudienceEvent(event);
        return;

      default:
        // Otros eventos del Core (p. ej. ticket.*, mfa.*) no requieren acción del bot en esta versión
        return;
    }
  }

  private async handleAcademicChanged(data: { entity?: string }): Promise<void> {
    if (data.entity && VALID_ACADEMIC_ENTITIES.has(data.entity as AcademicEntity)) {
      await this.deps.catalogCache.invalidateByAcademicEvent(data.entity as AcademicEntity);
    }
  }

  private async handleChannelLinkApproved(data: ChannelLinkApprovedEvent): Promise<void> {
    if (data.channel !== 'telegram') return;

    const pending = await this.deps.pendingLinkStore.get(data.externalUserId);
    if (pending) {
      try {
        await this.deps.coreClient.exchangeLinkCode(
          {
            externalUserId: data.externalUserId,
            chatId: pending.chatId,
            displayName: pending.displayName,
            ...(pending.username ? { username: pending.username } : {}),
          },
          pending.deviceCode,
        );
      } catch (err) {
        // Si el sondeo ganó la carrera y ya consumió el deviceCode, no bloqueamos el aviso
        if (!(err instanceof CoreApiError && err.code === 'INVALID_GRANT')) {
          throw err;
        }
      }
      await this.deps.pendingLinkStore.delete(data.externalUserId);
      await this.deps.handlers.onChannelLinkApproved(pending.chatId, data);
      return;
    }

    const account = await this.deps.accountsRepo.findByTelegramUserId(data.externalUserId);
    if (account) {
      await this.deps.handlers.onChannelLinkApproved(account.chatId, data);
    }
  }

  private async handleChannelLinkDenied(data: ChannelLinkDeniedEvent): Promise<void> {
    if (data.channel !== 'telegram') return;
    const pending = await this.deps.pendingLinkStore.consume(data.externalUserId);
    if (pending) {
      await this.deps.handlers.onChannelLinkDenied(pending.chatId, data);
    }
  }

  private async handleSessionRevoked(data: ChannelSessionRevokedEvent): Promise<void> {
    if (data.channel !== 'telegram') return;
    const account = await this.deps.accountsRepo.findByTelegramUserId(data.externalUserId);
    await this.deps.sessionManager.clearBySessionId(data.sessionId, data.externalUserId);

    // Ante BLOCKED ya informa el evento `account.blocked`; evitamos doble mensaje al mismo chat
    if (account && data.reason !== 'BLOCKED') {
      await this.deps.handlers.onChannelSessionRevoked(account.chatId, data);
    }
  }

  private async handleAccountBlocked(data: AccountBlockedEvent): Promise<void> {
    const chatIds = await this.deps.sessionManager.clearByCoreUserId(data.userId);
    for (const chatId of chatIds) {
      await this.deps.handlers.onAccountBlocked(chatId, data);
    }
  }

  private async dispatchAudienceEvent(event: CoreEventEnvelope): Promise<void> {
    if (!Array.isArray(event.audience) || event.audience.length === 0) return;

    const accounts = await this.deps.accountsRepo.findByCoreUserIds(event.audience);
    if (accounts.length === 0) return; // Descarte silencioso por privacidad (§11)

    if (event.type === 'notification.created') {
      const data = event.data as unknown as NotificationCreatedEvent;
      if (data.delivery?.telegram === false) return;
      if (data.kind === 'CHAT_MESSAGE' && data.delivery?.telegramChatMessages === false) return;

      for (const acc of accounts) {
        if (acc.coreUserId === data.userId) {
          await this.deps.handlers.onNotificationCreated(acc.chatId, data);
        }
      }
      return;
    }

    if (event.type === 'offer.message.created') {
      const data = event.data as unknown as OfferMessageCreatedEvent;
      for (const acc of accounts) {
        await this.deps.handlers.onOfferMessageCreated(acc.chatId, acc.coreUserId, data);
      }
      return;
    }

    if (event.type === 'offer.status.changed') {
      const data = event.data as unknown as OfferStatusChangedEvent;
      for (const acc of accounts) {
        await this.deps.handlers.onOfferStatusChanged(acc.chatId, data);
      }
      return;
    }

    if (event.type === 'account.unblocked') {
      const data = event.data as unknown as AccountUnblockedEvent;
      for (const acc of accounts) {
        await this.deps.handlers.onAccountUnblocked(acc.chatId, data);
      }
    }
  }
}
