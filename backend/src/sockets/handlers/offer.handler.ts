import { Server } from 'socket.io';
import { OfferStatus } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { notifyMany } from '../../services/notification.service';
import { AuthenticatedSocket } from '../socket.server';

/**
 * Registra los eventos de Socket.io relacionados con el chat de ofertas aceptadas.
 *
 * Eventos del cliente:
 *   join_offer_room  { offerId }  → une al usuario a la sala de chat de esa oferta
 *   send_offer_message { offerId, content } → envía un mensaje al chat
 *   leave_offer_room { offerId } → abandona la sala (no cierra la oferta)
 */
export function registerOfferHandlers(io: Server, socket: AuthenticatedSocket): void {
  const userId = socket.user.sub;

  // ── join_offer_room ───────────────────────────────────────
  socket.on('join_offer_room', async ({ offerId }: { offerId: string }) => {
    if (!offerId || typeof offerId !== 'string') return;

    const offer = await prisma.offer.findFirst({
      where: { id: offerId, deletedAt: null, status: OfferStatus.ACCEPTED },
      select: { userId: true, acceptedById: true },
    });

    // Solo el creador y el aceptante pueden unirse a la sala
    if (!offer || (offer.userId !== userId && offer.acceptedById !== userId)) {
      socket.emit('error', { message: 'No tienes acceso a esta sala de chat' });
      return;
    }

    const room = `offer:${offerId}`;
    await socket.join(room);
    socket.emit('joined_offer_room', { offerId, room });
  });

  // ── send_offer_message ────────────────────────────────────
  socket.on('send_offer_message', async ({ offerId, content }: { offerId: string; content: string }) => {
    if (!offerId || !content || typeof content !== 'string') return;

    const trimmed = content.trim();
    if (!trimmed || trimmed.length > 2000) return;

    // Verificar pertenencia y estado antes de persistir; incluir emails para notificaciones
    const offer = await prisma.offer.findFirst({
      where: { id: offerId, deletedAt: null, status: OfferStatus.ACCEPTED },
      select: {
        userId: true,
        acceptedById: true,
        user: { select: { email: true } },
        acceptedBy: { select: { email: true } },
      },
    });

    if (!offer || (offer.userId !== userId && offer.acceptedById !== userId)) {
      socket.emit('error', { message: 'No tienes acceso a esta sala de chat' });
      return;
    }

    const message = await prisma.message.create({
      data: { authorId: userId, offerId, content: trimmed },
      include: { author: { select: { id: true, name: true } } },
    });

    // Emitir el mensaje a ambas partes en la sala
    io.to(`offer:${offerId}`).emit('new_offer_message', {
      id: message.id,
      offerId,
      content: message.content,
      timestamp: message.timestamp,
      author: message.author,
    });

    // Persiste notificaciones en BD para ambas partes del chat
    if (offer.acceptedById && offer.user?.email && offer.acceptedBy?.email) {
      const asunto = 'Nuevo mensaje en tu cambio de grupo';
      const contenido = `Has recibido un mensaje en el chat de la oferta. Vista previa: "${trimmed.slice(0, 80)}"`;
      notifyMany(
        [
          { userId: offer.userId, email: offer.user.email },
          { userId: offer.acceptedById, email: offer.acceptedBy.email },
        ],
        asunto,
        contenido,
      ).catch((err) => console.error('[offer.handler] error creando notificaciones:', err));
    }

    // Notificación en tiempo real a AMBAS partes (también si no están en la sala)
    const counterpartId = offer.userId === userId ? offer.acceptedById : offer.userId;
    if (counterpartId) {
      io.to(`user:${counterpartId}`).emit('receive_notification', {
        type: 'new_offer_message',
        offerId,
        preview: trimmed.slice(0, 80),
      });
    }
    // También al propio remitente (para confirmación en otras pestañas)
    io.to(`user:${userId}`).emit('receive_notification', {
      type: 'new_offer_message',
      offerId,
      preview: trimmed.slice(0, 80),
    });
  });

  // ── leave_offer_room ──────────────────────────────────────
  socket.on('leave_offer_room', async ({ offerId }: { offerId: string }) => {
    if (!offerId || typeof offerId !== 'string') return;
    await socket.leave(`offer:${offerId}`);
  });
}
