import { OfferStatus, Role } from '@prisma/client';

import { AppError } from '../middleware/errorHandler';
import { prisma } from '../config/prisma';
import * as offerRepo from '../repositories/offer.repository';
import { notifyMany } from './notification.service';
import { logAction } from './log.service';
import { getIo } from '../sockets/socket.server';

// ── Tipos de entrada ──────────────────────────────────────────

export interface CreateOfferInput {
  userId: string;
  asignaturaId: string;
  grupoDeseadoId: string;
  grupoActualId: string;
}

export interface SearchOffersInput {
  asignaturaId?: string;
  grupoDeseadoId?: string;
  grupoActualId?: string;
}

// ── create ────────────────────────────────────────────────────

export async function create(input: CreateOfferInput) {
  const user = await prisma.user.findFirst({
    where: { id: input.userId, deletedAt: null },
    select: { role: true },
  });

  if (!user || user.role === Role.BLOQUEADO) {
    throw new AppError(403, 'No tienes permiso para crear ofertas');
  }

  // Verificar que los grupos pertenecen a la misma asignatura y no están eliminados
  const [grupoDeseado, grupoActual] = await Promise.all([
    prisma.grupo.findFirst({
      where: { id: input.grupoDeseadoId, asignaturaId: input.asignaturaId, deletedAt: null },
    }),
    prisma.grupo.findFirst({
      where: { id: input.grupoActualId, asignaturaId: input.asignaturaId, deletedAt: null },
    }),
  ]);

  if (!grupoDeseado || !grupoActual) {
    throw new AppError(400, 'Los grupos indicados no son válidos para esa asignatura');
  }

  if (input.grupoDeseadoId === input.grupoActualId) {
    throw new AppError(400, 'El grupo deseado y el grupo actual no pueden ser el mismo');
  }

  const offer = await offerRepo.createOffer(input);
  logAction({
    userId: input.userId,
    action: 'CREATE_OFFER',
    payload: { offerId: offer.id, asignaturaId: input.asignaturaId, grupoActualId: input.grupoActualId, grupoDeseadoId: input.grupoDeseadoId },
  }).catch(console.error);
  return offer;
}

// ── search ────────────────────────────────────────────────────

export async function search(filter: SearchOffersInput) {
  return offerRepo.findActiveOffers(filter);
}

// ── acceptOffer ───────────────────────────────────────────────

export async function acceptOffer(offerId: string, acceptorId: string) {
  const offer = await offerRepo.findById(offerId);

  if (!offer) {
    throw new AppError(404, 'Oferta no encontrada');
  }

  if (offer.status !== OfferStatus.OPEN) {
    throw new AppError(409, 'Esta oferta ya no está disponible');
  }

  if (offer.userId === acceptorId) {
    throw new AppError(400, 'No puedes aceptar tu propia oferta');
  }

  // Comprobar que el aceptante no está bloqueado
  const acceptor = await prisma.user.findFirst({
    where: { id: acceptorId, deletedAt: null },
    select: { id: true, name: true, email: true, role: true },
  });

  if (!acceptor || acceptor.role === Role.BLOQUEADO) {
    throw new AppError(403, 'No tienes permiso para aceptar ofertas');
  }

  // Obtener datos del creador para la notificación
  const creator = await prisma.user.findFirst({
    where: { id: offer.userId, deletedAt: null },
    select: { id: true, name: true, email: true },
  });

  if (!creator) {
    throw new AppError(500, 'Error interno: no se encontró el creador de la oferta');
  }

  // Transición de estado
  await offerRepo.updateStatus(offerId, OfferStatus.ACCEPTED, acceptorId);
  logAction({
    userId: acceptorId,
    action: 'ACCEPT_OFFER',
    payload: { offerId, creatorId: offer.userId },
  }).catch(console.error);

  // El nombre de la sala Socket.io para el chat entre las dos partes
  const roomName = `offer:${offerId}`;

  // Emitir evento a ambos usuarios si están conectados (no bloqueante)
  const io = getIo();
  io.to(roomName).emit('offer_accepted', {
    offerId,
    acceptorId: acceptor.id,
    acceptorName: acceptor.name,
    acceptorEmail: acceptor.email,
  });

  // Notificaciones persistentes + email a ambas partes
  const notificationContent =
    `El intercambio de grupo ha sido aceptado.\n` +
    `Oferta: ${offer.asignatura.nombre} · ${offer.grupoActual.nombre} ↔ ${offer.grupoDeseado.nombre}\n` +
    `Creador: ${creator.name} (${creator.email})\n` +
    `Aceptado por: ${acceptor.name} (${acceptor.email})`;

  await notifyMany(
    [
      { userId: creator.id, email: creator.email },
      { userId: acceptor.id, email: acceptor.email },
    ],
    'Oferta de cambio de grupo aceptada',
    notificationContent,
  );

  return offerRepo.findById(offerId);
}

// ── closeOffer ────────────────────────────────────────────────

export async function closeOffer(offerId: string, requesterId: string, requesterRole: Role) {
  const offer = await offerRepo.findById(offerId);

  if (!offer) {
    throw new AppError(404, 'Oferta no encontrada');
  }

  if (offer.status === OfferStatus.CLOSED) {
    throw new AppError(409, 'La oferta ya está cerrada');
  }

  // Puede cerrar: el creador, el aceptante (si la oferta está ACCEPTED) o un admin
  const isCreator = offer.userId === requesterId;
  const isAcceptor = offer.acceptedById === requesterId;
  const isAdmin = requesterRole === Role.EMBAJADOR || requesterRole === Role.PROPIETARIO;

  if (!isCreator && !isAcceptor && !isAdmin) {
    throw new AppError(403, 'Solo el creador de la oferta o un administrador pueden cerrarla');
  }

  await offerRepo.updateStatus(offerId, OfferStatus.CLOSED);
  logAction({
    userId: requesterId,
    action: 'CLOSE_OFFER',
    payload: { offerId, byAdmin: isAdmin },
  }).catch(console.error);

  // Notificar cierre en la sala si había un chat activo
  const io = getIo();
  io.to(`offer:${offerId}`).emit('offer_closed', { offerId });

  return offerRepo.findById(offerId);
}

/** Devuelve todas las ofertas del usuario (panel de usuario) */
export async function getUserOffers(userId: string) {
  return offerRepo.findByUserId(userId);
}

/** Devuelve una oferta con sus mensajes (para la página de chat) */
export async function getOfferById(offerId: string, requesterId: string) {
  const offer = await offerRepo.findById(offerId);
  if (!offer) throw new AppError(404, 'Oferta no encontrada');

  const isParticipant = offer.userId === requesterId || offer.acceptedById === requesterId;
  if (!isParticipant) throw new AppError(403, 'No tienes acceso a esta oferta');

  // Cargar mensajes del chat
  const messages = await prisma.message.findMany({
    where: { offerId },
    include: { author: { select: { id: true, name: true } } },
    orderBy: { timestamp: 'asc' },
  });

  return { ...offer, messages };
}

/** Persiste un mensaje de chat de oferta (endpoint REST) y lo emite por socket */
export async function sendMessage(offerId: string, authorId: string, content: string) {
  const offer = await offerRepo.findById(offerId);
  if (!offer) throw new AppError(404, 'Oferta no encontrada');
  if (offer.status !== OfferStatus.ACCEPTED) throw new AppError(409, 'El chat solo está disponible para ofertas aceptadas');

  const isParticipant = offer.userId === authorId || offer.acceptedById === authorId;
  if (!isParticipant) throw new AppError(403, 'No tienes acceso a esta oferta');

  const message = await prisma.message.create({
    data: { offerId, authorId, content },
    include: { author: { select: { id: true, name: true } } },
  });

  const io = getIo();
  io.to(`offer:${offerId}`).emit('new_offer_message', {
    id: message.id,
    offerId,
    content: message.content,
    timestamp: message.timestamp,
    author: message.author,
  });

  // Notificación en sistema + email a ambas partes
  if (offer.acceptedById && offer.user?.email && offer.acceptedBy?.email) {
    const asunto = 'Nuevo mensaje en tu cambio de grupo';
    const preview = content.slice(0, 80);
    const contenido = `Has recibido un mensaje en el chat de la oferta.\nVista previa: "${preview}"`;
    notifyMany(
      [
        { userId: offer.userId, email: offer.user.email },
        { userId: offer.acceptedById, email: offer.acceptedBy.email },
      ],
      asunto,
      contenido,
    ).catch((err) => console.error('[offer.service] error creando notificaciones de mensaje:', err));

    // Notificación en tiempo real a ambas partes (incluso si no están en la sala)
    const counterpartId = offer.userId === authorId ? offer.acceptedById : offer.userId;
    io.to(`user:${counterpartId}`).emit('receive_notification', {
      type: 'new_offer_message',
      offerId,
      preview,
    });
    io.to(`user:${authorId}`).emit('receive_notification', {
      type: 'new_offer_message',
      offerId,
      preview,
    });
  }

  return message;
}
