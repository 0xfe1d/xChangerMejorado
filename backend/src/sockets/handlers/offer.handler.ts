import { Server } from 'socket.io';
import { OfferStatus, Role } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { sendMessage } from '../../services/offer.service';
import { AuthenticatedSocket } from '../socket.server';

/**
 * Chat de ofertas aceptadas.
 *   join_offer_room    { offerId }
 *   send_offer_message { offerId, content } → mismo servicio que el REST (RF-CHT-07)
 *   leave_offer_room   { offerId }
 */
export function registerOfferHandlers(_io: Server, socket: AuthenticatedSocket): void {
  const userId = socket.user.sub;

  socket.on('join_offer_room', async ({ offerId }: { offerId: string }) => {
    if (!offerId || typeof offerId !== 'string') return;
    const offer = await prisma.offer.findFirst({
      where: { id: offerId, deletedAt: null, status: { in: [OfferStatus.ACCEPTED, OfferStatus.CLOSED] } },
      select: { userId: true, acceptedById: true },
    });
    // Solo creador y aceptante; un chat cerrado se puede abrir en solo lectura (RF-CHT-08)
    if (!offer || (offer.userId !== userId && offer.acceptedById !== userId)) {
      socket.emit('error', { message: 'No tienes acceso a esta sala de chat' });
      return;
    }
    const room = `offer:${offerId}`;
    await socket.join(room);
    socket.emit('joined_offer_room', { offerId, room });
  });

  socket.on('send_offer_message', async ({ offerId, content }: { offerId: string; content: string }) => {
    if (!offerId || typeof content !== 'string') return;
    try {
      // RF-BLQ-04: se revalida el estado del autor en cada mensaje
      const author = await prisma.user.findFirst({ where: { id: userId, deletedAt: null }, select: { role: true } });
      if (!author || author.role === Role.BLOQUEADO) {
        socket.emit('error', { message: 'Tu cuenta está bloqueada' });
        socket.disconnect(true);
        return;
      }
      await sendMessage(offerId, userId, content);
    } catch (err) {
      socket.emit('error', { message: err instanceof Error ? err.message : 'Error desconocido' });
    }
  });

  socket.on('leave_offer_room', async ({ offerId }: { offerId: string }) => {
    if (!offerId || typeof offerId !== 'string') return;
    await socket.leave(`offer:${offerId}`);
  });
}
