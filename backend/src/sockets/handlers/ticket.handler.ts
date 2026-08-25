import { Server } from 'socket.io';
import { TicketStatus, Role } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { AuthenticatedSocket } from '../socket.server';
import { sendTicketMessage } from '../../services/ticket.service';

/**
 * Eventos del cliente:
 *   join_ticket_room  { ticketId }           → une al usuario a la sala del ticket
 *   send_ticket_message { ticketId, content } → envía mensaje y persiste en BD
 *   leave_ticket_room { ticketId }            → abandona la sala
 */
export function registerTicketHandlers(io: Server, socket: AuthenticatedSocket): void {
  const userId = socket.user.sub;
  const userRole = socket.user.role;

  // ── join_ticket_room ──────────────────────────────────────
  socket.on('join_ticket_room', async ({ ticketId }: { ticketId: string }) => {
    if (!ticketId || typeof ticketId !== 'string') return;

    const ticket = await prisma.ticket.findFirst({
      where: { id: ticketId, deletedAt: null },
      select: { userId: true, adminId: true, status: true },
    });

    if (!ticket) {
      socket.emit('error', { message: 'Ticket no encontrado' });
      return;
    }

    const isOwner = ticket.userId === userId;
    const isAdmin = userRole === Role.EMBAJADOR || userRole === Role.PROPIETARIO;

    if (!isOwner && !isAdmin) {
      socket.emit('error', { message: 'No tienes acceso a este ticket' });
      return;
    }

    const room = `ticket:${ticketId}`;
    await socket.join(room);
    socket.emit('joined_ticket_room', { ticketId, room });
  });

  // ── send_ticket_message ───────────────────────────────────
  // Los mensajes vía socket se delegan al servicio, que persiste y emite.
  // Se usa el mismo flujo que el endpoint REST para no duplicar lógica.
  socket.on(
    'send_ticket_message',
    async ({ ticketId, content }: { ticketId: string; content: string }) => {
      if (!ticketId || !content || typeof content !== 'string') return;

      try {
        await sendTicketMessage(ticketId, userId, content, userRole as Role);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Error desconocido';
        socket.emit('error', { message });
      }
    },
  );

  // ── leave_ticket_room ─────────────────────────────────────
  socket.on('leave_ticket_room', async ({ ticketId }: { ticketId: string }) => {
    if (!ticketId || typeof ticketId !== 'string') return;
    await socket.leave(`ticket:${ticketId}`);
  });
}
