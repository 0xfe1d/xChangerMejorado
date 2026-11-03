import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import { newUlid } from '../utils/ids';
import { currentRequestId } from '../utils/request-context';
import { EventEnvelope, EventType, EVENT_VERSION } from './types';

type Tx = Prisma.TransactionClient;
type Listener = () => void;

const listeners: Listener[] = [];

/** El publicador del outbox se suscribe para vaciar en cuanto hay eventos nuevos. */
export function onEventEnqueued(listener: Listener): void {
  listeners.push(listener);
}

export interface PublishOptions {
  audience?: string[];
  /** Si se pasa, el evento se inserta en la misma transacción que el cambio de negocio. */
  tx?: Tx;
}

/**
 * Puerto EventPublisher (AR-04). Los servicios ya no conocen Socket.io:
 * publican un evento y la difusión la hacen los consumidores del stream.
 * El evento se persiste en el outbox (ADR-22); si va en la transacción del
 * negocio, nunca se anuncia algo que luego se revierte.
 */
export async function publish<T extends Record<string, unknown>>(
  type: EventType,
  data: T,
  options: PublishOptions = {},
): Promise<EventEnvelope<T>> {
  const envelope: EventEnvelope<T> = {
    id: newUlid(),
    type,
    version: EVENT_VERSION,
    occurredAt: new Date().toISOString(),
    producer: 'xchanger-core',
    requestId: currentRequestId(),
    audience: [...new Set(options.audience ?? [])],
    data,
  };
  const client = options.tx ?? prisma;
  await client.outbox.create({
    data: { id: envelope.id, type, payload: envelope as unknown as Prisma.InputJsonValue },
  });
  // Fuera de transacción ya está confirmado: avisar al publicador
  if (!options.tx) notifyEnqueued();
  return envelope;
}

/** Llamar tras confirmar una transacción que publicó eventos. */
export function notifyEnqueued(): void {
  for (const l of listeners) l();
}
