import {
  AccountBlockedEvent,
  AccountUnblockedEvent,
  BotEventHandlers,
  ChannelLinkApprovedEvent,
  ChannelLinkDeniedEvent,
  ChannelSessionRevokedEvent,
  NotificationCreatedEvent,
  OfferMessageCreatedEvent,
  OfferStatusChangedEvent,
} from '../contracts';
import { OutboundQueue } from '../back/telegram/outbound-queue';

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const REVOCATION_REASONS: Record<ChannelSessionRevokedEvent['reason'], string> = {
  USER: 'Has cerrado la sesión desde xChanger.',
  ADMIN: 'Un administrador ha revocado tu sesión.',
  BLOCKED: 'Tu cuenta ha sido bloqueada.',
  REUSE_DETECTED: 'Se detectó un problema de seguridad en tu sesión.',
  MFA_RESET: 'Tu configuración MFA fue restablecida.',
};

const OFFER_STATUS_LABELS: Record<OfferStatusChangedEvent['to'], string> = {
  OPEN: 'Abierta',
  ACCEPTED: 'Aceptada',
  CLOSED: 'Cerrada',
  INACTIVE: 'Inactiva',
};

/**
 * Handlers de salida para eventos asíncronos recibidos desde Redis Streams (`xchanger:events`).
 * Todos los envíos pasan por `OutboundQueue` para respetar los límites de Telegram.
 */
export function createEventHandlers(outbound: OutboundQueue): BotEventHandlers {
  const sendHtml = (chatId: string, text: string) =>
    outbound.sendMessage(chatId, text, { parse_mode: 'HTML' }).then(() => undefined);

  return {
    async onChannelLinkApproved(chatId: string, _event: ChannelLinkApprovedEvent): Promise<void> {
      await sendHtml(
        chatId,
        '✅ <b>¡Cuenta vinculada correctamente!</b>\n\nYa puedes usar /perfil, /expediente, /buscar, /ofertar, /misofertas o /ayuda.',
      );
    },

    async onChannelLinkDenied(chatId: string, _event: ChannelLinkDeniedEvent): Promise<void> {
      await sendHtml(
        chatId,
        '❌ La solicitud de vinculación fue denegada desde la web. Puedes iniciar otra cuando quieras con /vincular.',
      );
    },

    async onNotificationCreated(chatId: string, event: NotificationCreatedEvent): Promise<void> {
      // `offer.message.created` ya envía el aviso enriquecido de chat (y excluye al autor)
      if (event.kind === 'CHAT_MESSAGE') return;
      const title = escapeHtml(event.asunto);
      const body = escapeHtml(event.contenido);
      await sendHtml(chatId, `🔔 <b>${title}</b>\n${body}`);
    },

    async onOfferMessageCreated(
      chatId: string,
      recipientCoreUserId: string,
      event: OfferMessageCreatedEvent,
    ): Promise<void> {
      if (event.authorId === recipientCoreUserId) return;
      const author = escapeHtml(event.authorName);
      const content = escapeHtml(event.content);
      await sendHtml(
        chatId,
        `💬 <b>Nuevo mensaje de ${author}</b>\n${content}\n\nUsa /chat para responder desde Telegram.`,
      );
    },

    async onOfferStatusChanged(chatId: string, event: OfferStatusChangedEvent): Promise<void> {
      const subject = `${escapeHtml(event.asignatura.codigo)} — ${escapeHtml(event.asignatura.nombre)}`;
      const fromLabel = OFFER_STATUS_LABELS[event.from] ?? event.from;
      const toLabel = OFFER_STATUS_LABELS[event.to] ?? event.to;
      await sendHtml(
        chatId,
        `📢 <b>Cambio de estado en una oferta</b>\nAsignatura: ${subject}\nEstado: <b>${escapeHtml(fromLabel)}</b> → <b>${escapeHtml(toLabel)}</b>\n\nConsulta los detalles en /misofertas.`,
      );
    },

    async onChannelSessionRevoked(chatId: string, event: ChannelSessionRevokedEvent): Promise<void> {
      const reasonText = REVOCATION_REASONS[event.reason] ?? 'Tu sesión en Telegram fue cerrada.';
      await sendHtml(
        chatId,
        `🔒 <b>Sesión cerrada</b>\n${escapeHtml(reasonText)}\n\nVuelve a vincularte con /vincular o /entrar cuando lo necesites.`,
      );
    },

    async onAccountBlocked(chatId: string, event: AccountBlockedEvent): Promise<void> {
      const detail = event.permanent
        ? 'Bloqueo permanente.'
        : event.until
          ? `Bloqueo temporal hasta ${escapeHtml(event.until)}.`
          : 'Bloqueo temporal.';
      const reason = event.reason ? `\nMotivo: ${escapeHtml(event.reason)}` : '';
      await sendHtml(chatId, `⛔ <b>Cuenta bloqueada</b>\n${detail}${reason}`);
    },

    async onAccountUnblocked(chatId: string, _event: AccountUnblockedEvent): Promise<void> {
      await sendHtml(
        chatId,
        '✅ <b>Tu cuenta ha sido desbloqueada.</b>\nPuedes volver a iniciar sesión con /vincular o /entrar.',
      );
    },
  };
}
