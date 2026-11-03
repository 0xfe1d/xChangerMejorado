// Contrato de eventos asíncronos (§11). Sobre común + catálogo de tipos.

export const EVENTS_STREAM = 'xchanger:events';
export const EVENT_VERSION = 1;

export interface EventEnvelope<T = Record<string, unknown>> {
  id: string; // ULID, clave de deduplicación
  type: EventType;
  version: number;
  occurredAt: string;
  producer: 'xchanger-core';
  requestId?: string;
  audience: string[]; // usuarios a los que concierne
  data: T;
}

export type NotificationKind =
  | 'OFFER_CREATED'
  | 'OFFER_ACCEPTED'
  | 'CHAT_MESSAGE'
  | 'ENTITY_DELETED'
  | 'TICKET_MESSAGE'
  | 'SECURITY'
  | 'GENERAL';

export type EventType =
  | 'notification.created'
  | 'offer.message.created'
  | 'offer.status.changed'
  | 'account.blocked'
  | 'account.unblocked'
  | 'channel.link.approved'
  | 'channel.link.denied'
  | 'channel.session.revoked'
  | 'academic.changed'
  | 'mfa.enabled'
  | 'mfa.disabled'
  // Internos del core (la web los necesita; el bot puede ignorarlos)
  | 'ticket.message.created'
  | 'ticket.closed';
