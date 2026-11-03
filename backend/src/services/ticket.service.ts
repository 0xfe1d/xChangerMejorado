import { Role, TicketStatus } from '@prisma/client';

import { AppError } from '../middleware/errorHandler';
import { prisma } from '../config/prisma';
import * as ticketRepo from '../repositories/ticket.repository';
import { notifyMany } from './notification.service';
import { logAction } from './log.service';
import { publish } from '../events/event-publisher';

// ── Helpers de ámbito ─────────────────────────────────────────

/**
 * Devuelve las carreraIds y cursoIds del ámbito de un administrador.
 * PROPIETARIO → null (sin restricción).
 */
async function getAdminScopeIds(
  userId: string,
  role: Role,
): Promise<{ carreraIds: string[]; cursoIds: string[] } | null> {
  if (role === Role.PROPIETARIO) return null;

  const scopes = await prisma.adminScope.findMany({ where: { userId } });
  return {
    carreraIds: scopes.map((s) => s.carreraId),
    cursoIds: scopes.flatMap((s) => (s.cursoId ? [s.cursoId] : [])),
  };
}

// ── openTicket ────────────────────────────────────────────────

export async function openTicket(userId: string, asunto: string, mensaje?: string) {
  if (!asunto.trim()) throw new AppError(400, 'El asunto no puede estar vacío');

  const ticket = await ticketRepo.createTicket(userId, asunto.trim());

  if (mensaje?.trim()) {
    await ticketRepo.addMessage(ticket.id, userId, mensaje.trim());
  }

  logAction({ userId, action: 'OPEN_TICKET', payload: { ticketId: ticket.id, asunto } }).catch(
    console.error,
  );

  return ticket;
}

// ── closeTicket ───────────────────────────────────────────────

export async function closeTicket(ticketId: string, requesterId: string, requesterRole: Role) {
  const ticket = await ticketRepo.findTicketById(ticketId);
  if (!ticket) throw new AppError(404, 'Ticket no encontrado');
  if (ticket.status === TicketStatus.CLOSED) throw new AppError(409, 'El ticket ya está cerrado');

  const isOwner = ticket.userId === requesterId;
  const isAdmin = requesterRole === Role.EMBAJADOR || requesterRole === Role.PROPIETARIO;

  if (!isOwner && !isAdmin) {
    throw new AppError(403, 'No tienes permiso para cerrar este ticket');
  }

  const updated = await ticketRepo.updateTicketStatus(ticketId, TicketStatus.CLOSED);

  await publish('ticket.closed', { ticketId }, { audience: [ticket.userId] });

  logAction({
    userId: requesterId,
    action: 'CLOSE_TICKET',
    payload: { ticketId },
  }).catch(console.error);

  return updated;
}

// ── getMyTickets ──────────────────────────────────────────────

export async function getMyTickets(userId: string) {
  return ticketRepo.findTicketsByUser(userId);
}

// ── getAdminTickets ───────────────────────────────────────────

export interface AdminTicketQuery {
  status?: TicketStatus;
  asuntoFilter?: string;
  userFilter?: string;
}

export async function getAdminTickets(
  requesterId: string,
  requesterRole: Role,
  query: AdminTicketQuery = {},
) {
  const scopeIds = await getAdminScopeIds(requesterId, requesterRole);

  // PROPIETARIO ve todos los tickets (carreraIds: null = sin restricción)
  if (scopeIds === null) {
    return ticketRepo.findTicketsInScope({ carreraIds: null, ...query });
  }

  if (scopeIds.carreraIds.length === 0) {
    return [];
  }

  return ticketRepo.findTicketsInScope({ ...scopeIds, ...query });
}

// ── getTicketDetail ───────────────────────────────────────────

export async function getTicketDetail(ticketId: string, requesterId: string, requesterRole: Role) {
  const ticket = await ticketRepo.findTicketById(ticketId);
  if (!ticket) throw new AppError(404, 'Ticket no encontrado');

  const isOwner = ticket.userId === requesterId;
  const isAdmin = requesterRole === Role.EMBAJADOR || requesterRole === Role.PROPIETARIO;

  if (!isOwner && !isAdmin) {
    throw new AppError(403, 'No tienes acceso a este ticket');
  }

  return ticket;
}

// ── sendMessage ───────────────────────────────────────────────

export async function sendTicketMessage(
  ticketId: string,
  authorId: string,
  content: string,
  authorRole: Role,
) {
  const ticket = await ticketRepo.findTicketById(ticketId);
  if (!ticket) throw new AppError(404, 'Ticket no encontrado');
  if (ticket.status === TicketStatus.CLOSED) {
    throw new AppError(409, 'No puedes enviar mensajes a un ticket cerrado');
  }

  const isParticipant =
    ticket.userId === authorId ||
    authorRole === Role.EMBAJADOR ||
    authorRole === Role.PROPIETARIO;

  if (!isParticipant) throw new AppError(403, 'No tienes acceso a este ticket');

  const trimmed = content.trim();
  if (!trimmed || trimmed.length > 2000) throw new AppError(400, 'Contenido de mensaje inválido');

  // Si el admin que responde es diferente al asignado, lo actualizamos
  if (
    (authorRole === Role.EMBAJADOR || authorRole === Role.PROPIETARIO) &&
    ticket.adminId !== authorId
  ) {
    await ticketRepo.updateTicketStatus(ticketId, TicketStatus.OPEN, authorId);
  }

  const message = await ticketRepo.addMessage(ticketId, authorId, trimmed);

  // Difusión por el bus de eventos (la pasarela de sockets lo emite a la sala)
  await publish(
    'ticket.message.created',
    {
      ticketId,
      messageId: message.id,
      authorId,
      authorName: message.author.name,
      content: message.content,
      timestamp: message.timestamp.toISOString(),
    },
    { audience: [ticket.userId, ...(ticket.adminId ? [ticket.adminId] : [])] },
  );

  // Notificación al creador del ticket si el mensaje lo envía el admin (y viceversa)
  const recipientId = ticket.userId === authorId ? (ticket.adminId ?? null) : ticket.userId;
  const recipient = recipientId
    ? await prisma.user.findFirst({
        where: { id: recipientId, deletedAt: null },
        select: { id: true, email: true, name: true },
      })
    : null;

  if (recipient) {
    // notification.created ya avisa en tiempo real por la sala personal
    await notifyMany(
      [{ userId: recipient.id }],
      `Nuevo mensaje en tu ticket: ${ticket.asunto}`,
      `Has recibido un nuevo mensaje en el ticket "${ticket.asunto}".`,
      { kind: 'TICKET_MESSAGE', refs: { ticketId } },
    );
  }

  return message;
}
