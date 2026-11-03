import { prisma } from '../config/prisma';
import { escapeHtml } from '../utils/html';
import { sendNotificationEmail } from '../services/email.service';
import { getIoOrNull } from '../sockets/socket.server';
import { StreamConsumer } from './stream-consumer';
import { EventEnvelope } from './types';

// ── socket-gateway: traduce eventos a las salas de Socket.io ──────────
// Mantiene los nombres y formas de evento que ya consume el frontend (RE-WS).

export async function socketGatewayHandler(event: EventEnvelope): Promise<void> {
  const io = getIoOrNull();
  if (!io) return; // proceso sin servidor de sockets (tests unitarios)
  const d = event.data as Record<string, any>;

  switch (event.type) {
    case 'notification.created':
      io.to(`user:${d.userId}`).emit('receive_notification', {
        type: 'notification',
        notificationId: d.notificationId,
        asunto: d.asunto,
        kind: d.kind,
        refs: d.refs,
      });
      break;
    case 'offer.message.created': {
      io.to(`offer:${d.offerId}`).emit('new_offer_message', {
        id: d.messageId,
        offerId: d.offerId,
        content: d.content,
        timestamp: d.timestamp,
        author: { id: d.authorId, name: d.authorName },
      });
      for (const uid of event.audience) {
        io.to(`user:${uid}`).emit('receive_notification', { type: 'new_offer_message', offerId: d.offerId, preview: String(d.content).slice(0, 80) });
      }
      break;
    }
    case 'offer.status.changed':
      if (d.to === 'ACCEPTED') {
        const payload = { offerId: d.offerId, acceptorId: d.actorId };
        io.to(`offer:${d.offerId}`).emit('offer_accepted', payload);
        for (const uid of event.audience) io.to(`user:${uid}`).emit('offer_accepted', payload);
      } else if (d.to === 'CLOSED') {
        io.to(`offer:${d.offerId}`).emit('offer_closed', { offerId: d.offerId });
      }
      break;
    case 'ticket.message.created':
      io.to(`ticket:${d.ticketId}`).emit('new_ticket_message', {
        id: d.messageId,
        ticketId: d.ticketId,
        content: d.content,
        timestamp: d.timestamp,
        author: { id: d.authorId, name: d.authorName },
      });
      break;
    case 'ticket.closed':
      io.to(`ticket:${d.ticketId}`).emit('ticket_closed', { ticketId: d.ticketId });
      break;
    case 'account.blocked':
      io.to(`user:${d.userId}`).emit('account_blocked', { reason: d.reason, blockedUntil: d.until });
      // Las conexiones abiertas del bloqueado se cierran (RF-BLQ-04)
      io.in(`user:${d.userId}`).disconnectSockets(true);
      break;
    default:
      break;
  }
}

// ── email-sender: el correo es un consumidor más, con reintentos (AR-10) ──

export function buildNotificationEmailHtml(subject: string, body: string): string {
  const safeBody = escapeHtml(body).replace(/\n/g, '<br/>');
  return `
    <div style="font-family:sans-serif;max-width:560px;margin:auto">
      <h2>${escapeHtml(subject)}</h2>
      <p>${safeBody}</p>
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:1.5rem 0"/>
      <p style="color:#9ca3af;font-size:0.75rem;text-align:center">
        xChanger — Universidad de Cantabria · No es un sistema oficial.
      </p>
    </div>
  `;
}

export async function emailSenderHandler(event: EventEnvelope): Promise<void> {
  if (event.type !== 'notification.created') return;
  const d = event.data as { userId: string; asunto: string; contenido: string };
  const user = await prisma.user.findFirst({ where: { id: d.userId }, select: { email: true } });
  if (!user) return;
  // Si lanza, el consumidor reintenta (RF-NOT-02: la notificación ya está persistida)
  await sendNotificationEmail(user.email, d.asunto, buildNotificationEmailHtml(d.asunto, d.contenido));
}

export const socketGateway = new StreamConsumer('socket-gateway', socketGatewayHandler);
export const emailSender = new StreamConsumer('email-sender', emailSenderHandler);

export const CORE_CONSUMERS = [socketGateway, emailSender];
