import { TicketStatus } from '@prisma/client';
import { prisma } from '../config/prisma';

const TICKET_INCLUDE = {
  user: { select: { id: true, name: true, email: true, carreraId: true, cursoId: true } },
  admin: { select: { id: true, name: true, email: true } },
} as const;

const MESSAGE_INCLUDE = {
  author: { select: { id: true, name: true } },
} as const;

export async function createTicket(userId: string, asunto: string) {
  return prisma.ticket.create({
    data: { userId, asunto, status: TicketStatus.OPEN },
    include: TICKET_INCLUDE,
  });
}

export async function findTicketById(id: string) {
  return prisma.ticket.findFirst({
    where: { id, deletedAt: null },
    include: {
      ...TICKET_INCLUDE,
      messages: { include: MESSAGE_INCLUDE, orderBy: { timestamp: 'asc' } },
    },
  });
}

/** Tickets abiertos por el propio usuario */
export async function findTicketsByUser(userId: string) {
  return prisma.ticket.findMany({
    where: { userId, deletedAt: null },
    include: TICKET_INCLUDE,
    orderBy: { createdAt: 'desc' },
  });
}

export interface AdminTicketFilter {
  /** null = PROPIETARIO sin restricción de ámbito; string[] = carreraIds del embajador */
  carreraIds: string[] | null;
  cursoIds?: string[];
  status?: TicketStatus;
  asuntoFilter?: string;
  userFilter?: string;
}

/**
 * Tickets cuyo autor pertenece al ámbito de administración del solicitante.
 * Solo devuelve tickets no eliminados.
 */
export async function findTicketsInScope(filter: AdminTicketFilter) {
  // Filtro de ámbito por carrera/curso del usuario que creó el ticket
  const scopeFilter =
    filter.carreraIds !== null
      ? {
          OR: [
            { carreraId: { in: filter.carreraIds } },
            ...(filter.cursoIds && filter.cursoIds.length > 0
              ? [{ cursoId: { in: filter.cursoIds } }]
              : []),
          ],
        }
      : {}; // PROPIETARIO: sin restricción

  // Filtro de texto por nombre/email del usuario
  const userTextFilter = filter.userFilter
    ? {
        OR: [
          { name: { contains: filter.userFilter, mode: 'insensitive' as const } },
          { email: { contains: filter.userFilter, mode: 'insensitive' as const } },
        ],
      }
    : {};

  return prisma.ticket.findMany({
    where: {
      deletedAt: null,
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.asuntoFilter
        ? { asunto: { contains: filter.asuntoFilter, mode: 'insensitive' } }
        : {}),
      user: { deletedAt: null, ...scopeFilter, ...userTextFilter },
    },
    include: TICKET_INCLUDE,
    orderBy: { createdAt: 'desc' },
  });
}

export async function updateTicketStatus(id: string, status: TicketStatus, adminId?: string) {
  return prisma.ticket.update({
    where: { id },
    data: {
      status,
      ...(adminId !== undefined ? { adminId } : {}),
    },
    include: TICKET_INCLUDE,
  });
}

export async function addMessage(ticketId: string, authorId: string, content: string) {
  return prisma.message.create({
    data: { ticketId, authorId, content },
    include: MESSAGE_INCLUDE,
  });
}

export async function getTicketMessages(ticketId: string) {
  return prisma.message.findMany({
    where: { ticketId },
    include: MESSAGE_INCLUDE,
    orderBy: { timestamp: 'asc' },
  });
}
