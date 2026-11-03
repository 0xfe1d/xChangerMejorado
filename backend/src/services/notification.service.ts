import { NotificationChannel, Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import { AppError } from '../middleware/errorHandler';
import { publish, notifyEnqueued } from '../events/event-publisher';
import { NotificationKind } from '../events/types';
import { encodeCursor, decodeCursor } from '../utils/cursor';
import * as repo from '../repositories/notification.repository';

export interface CreateNotificationInput {
  userId: string;
  asunto: string;
  contenido: string;
  kind?: NotificationKind;
  refs?: { offerId?: string; ticketId?: string };
  /** Obsoleto: el correo lo envía el consumidor email-sender buscando el email por userId. */
  email?: string;
}

/**
 * Persiste la notificación (fuente de verdad, ADR-12) y, en la misma
 * transacción, publica notification.created. El correo (RF-NOT-01), los
 * sockets y Telegram son consumidores del evento; un fallo de entrega no
 * revierte nada (RF-NOT-02) y se reintenta.
 */
export async function createNotification(input: CreateNotificationInput): Promise<void> {
  const telegram = await telegramDelivery(input.userId);
  await prisma.$transaction(async (tx) => {
    const n = await tx.notification.create({
      data: { userId: input.userId, asunto: input.asunto, contenido: input.contenido },
    });
    await publish(
      'notification.created',
      {
        notificationId: n.id,
        userId: input.userId,
        asunto: input.asunto,
        contenido: input.contenido,
        kind: input.kind ?? 'GENERAL',
        refs: input.refs ?? {},
        // Extensión compatible del contrato §11: el bot no necesita consultar preferencias
        delivery: { telegram: telegram.enabled, telegramChatMessages: telegram.chatMessages },
      },
      { audience: [input.userId], tx },
    );
  });
  notifyEnqueued();
}

/** Envía la misma notificación a varios usuarios. Acepta el formato antiguo {userId, email}. */
export async function notifyMany(
  recipients: Array<{ userId: string; email?: string }>,
  asunto: string,
  contenido: string,
  opts: Pick<CreateNotificationInput, 'kind' | 'refs'> = {},
): Promise<void> {
  await Promise.all(recipients.map((r) => createNotification({ userId: r.userId, asunto, contenido, ...opts })));
}

// ── Preferencias de canal (EP-C-17 / EP-C-18) ─────────────────

async function telegramDelivery(userId: string) {
  const [pref, linked] = await Promise.all([
    prisma.notificationPreference.findUnique({ where: { userId_channel: { userId, channel: NotificationChannel.TELEGRAM } } }),
    prisma.channelIdentity.count({ where: { userId, channel: 'TELEGRAM', revokedAt: null } }),
  ]);
  const active = linked > 0;
  return { linked: active, enabled: active && (pref?.enabled ?? true), chatMessages: pref?.chatMessages ?? true };
}

export async function getPreferences(userId: string) {
  const tg = await telegramDelivery(userId);
  return {
    email: { enabled: true, editable: false },
    telegram: { enabled: tg.enabled, linked: tg.linked, chatMessages: tg.chatMessages },
    web: { enabled: true },
  };
}

export interface UpdatePreferencesInput {
  email?: { enabled?: boolean };
  telegram?: { enabled?: boolean; chatMessages?: boolean };
}

export async function updatePreferences(userId: string, input: UpdatePreferencesInput) {
  if (input.email?.enabled === false) {
    throw new AppError(400, 'El correo es un canal obligatorio y no puede desactivarse', 'EMAIL_CHANNEL_REQUIRED');
  }
  if (input.telegram && (input.telegram.enabled !== undefined || input.telegram.chatMessages !== undefined)) {
    const { linked } = await telegramDelivery(userId);
    if (!linked) throw new AppError(409, 'No tienes Telegram vinculado', 'CHANNEL_NOT_LINKED');
    await repo.upsertPreference(userId, NotificationChannel.TELEGRAM, input.telegram);
  }
  return getPreferences(userId);
}

// ── Consulta y lectura (EP-R-14..16) ──────────────────────────

export async function list(userId: string, opts: { unread?: boolean; limit?: number; cursor?: string }) {
  let before = null;
  if (opts.cursor) {
    const pos = decodeCursor(opts.cursor);
    if (!pos) throw new AppError(400, 'Cursor inválido', 'VALIDATION_ERROR');
    before = { timestamp: pos.createdAt, id: pos.id };
  }
  const rows = await repo.listForUser({ userId, unread: opts.unread, limit: opts.limit, before });
  if (!opts.limit) return { items: rows, nextCursor: null };
  const hasMore = rows.length > opts.limit;
  const items = hasMore ? rows.slice(0, opts.limit) : rows;
  const last = items[items.length - 1];
  return { items, nextCursor: hasMore && last ? encodeCursor({ createdAt: last.timestamp, id: last.id }) : null };
}

export const unreadCount = (userId: string) => repo.countUnread(userId);

export async function markRead(userId: string, id: string) {
  const { count } = await repo.markRead(userId, id);
  if (count === 0) throw new AppError(404, 'Notificación no encontrada', 'NOT_FOUND');
}

export const markAllRead = (userId: string) => repo.markAllRead(userId);

export type { Prisma };
