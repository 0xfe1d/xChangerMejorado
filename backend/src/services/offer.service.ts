import { OfferStatus, Role } from '@prisma/client';

import { AppError } from '../middleware/errorHandler';
import { prisma } from '../config/prisma';
import * as offerRepo from '../repositories/offer.repository';
import { notifyMany, createNotification } from './notification.service';
import { assertHasExpediente } from './expediente.service';
import { logAction } from './log.service';
import { publish, notifyEnqueued } from '../events/event-publisher';
import { CursorPosition, encodeCursor } from '../utils/cursor';

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

export interface PageOptions {
  limit: number;
  after: CursorPosition | null;
}

// ── Formas de respuesta para clientes paginados (EP-C-12/13) ──
// Sin email de la contraparte: el bot solo necesita el nombre.

type Offer = offerRepo.OfferWithRelations;

function toSearchItem(o: Offer) {
  return {
    id: o.id,
    createdAt: o.createdAt,
    asignatura: o.asignatura,
    grupoActual: o.grupoActual,
    grupoDeseado: o.grupoDeseado,
    creator: { name: o.user.name },
  };
}

function toPanelItem(o: Offer, userId: string) {
  const isCreator = o.userId === userId;
  const counterpart = isCreator ? o.acceptedBy : o.user;
  return {
    id: o.id,
    createdAt: o.createdAt,
    status: o.status,
    asignatura: o.asignatura,
    grupoActual: o.grupoActual,
    grupoDeseado: o.grupoDeseado,
    isCreator,
    counterpart: o.status === OfferStatus.ACCEPTED && counterpart ? { name: counterpart.name } : null,
  };
}

function page<T, R>(rows: T[], limit: number, map: (r: T) => R, pos: (r: T) => CursorPosition) {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return { items: items.map(map), nextCursor: hasMore && last ? encodeCursor(pos(last)) : null };
}

// ── create ────────────────────────────────────────────────────

export async function create(input: CreateOfferInput) {
  const user = await prisma.user.findFirst({
    where: { id: input.userId, deletedAt: null },
    select: { role: true },
  });
  if (!user || user.role === Role.BLOQUEADO) {
    throw new AppError(403, 'No tienes permiso para crear ofertas', 'ACCOUNT_BLOCKED');
  }

  if (input.grupoDeseadoId === input.grupoActualId) {
    throw new AppError(400, 'El grupo deseado y el grupo actual no pueden ser el mismo');
  }

  // Ambos grupos de esa asignatura, sin eliminar ni con ancestro eliminado (RF-OFE-02)
  const activeGroup = (id: string) =>
    prisma.grupo.findFirst({
      where: {
        id,
        asignaturaId: input.asignaturaId,
        deletedAt: null,
        asignatura: { deletedAt: null, curso: { deletedAt: null, carrera: { deletedAt: null } } },
      },
    });
  const [grupoDeseado, grupoActual] = await Promise.all([activeGroup(input.grupoDeseadoId), activeGroup(input.grupoActualId)]);
  if (!grupoDeseado || !grupoActual) {
    throw new AppError(400, 'Los grupos indicados no son válidos para esa asignatura');
  }

  await assertHasExpediente(input.userId);

  const offer = await offerRepo.createOffer(input);
  logAction({
    userId: input.userId,
    action: 'CREATE_OFFER',
    payload: { offerId: offer.id, asignaturaId: input.asignaturaId, grupoActualId: input.grupoActualId, grupoDeseadoId: input.grupoDeseadoId },
  }).catch(console.error);

  // RF-OFE-07: aviso al creador de que su oferta está publicada
  await createNotification({
    userId: input.userId,
    asunto: 'Tu oferta de cambio de grupo está publicada',
    contenido: `Oferta: ${offer.asignatura.nombre} · tienes ${offer.grupoActual.nombre} y buscas ${offer.grupoDeseado.nombre}.`,
    kind: 'OFFER_CREATED',
    refs: { offerId: offer.id },
  });

  return offer;
}

// ── search ────────────────────────────────────────────────────

/** Formato actual (array completo) para la web. */
export async function search(filter: SearchOffersInput) {
  return offerRepo.findActiveOffers(filter);
}

/** Formato paginado para clientes de canal (EP-C-12): excluye las propias. */
export async function searchPage(filter: SearchOffersInput, requesterId: string, opts: PageOptions) {
  const rows = await offerRepo.findActiveOffers({ ...filter, excludeUserId: requesterId, limit: opts.limit, after: opts.after });
  return page(rows, opts.limit, toSearchItem, (o) => ({ createdAt: o.createdAt, id: o.id }));
}

// ── acceptOffer ───────────────────────────────────────────────

export async function acceptOffer(offerId: string, acceptorId: string) {
  const offer = await offerRepo.findById(offerId);
  if (!offer) throw new AppError(404, 'Oferta no encontrada');
  if (offer.userId === acceptorId) throw new AppError(400, 'No puedes aceptar tu propia oferta', 'OWN_OFFER');
  if (offer.status !== OfferStatus.OPEN) throw new AppError(409, 'Esta oferta ya no está disponible', 'OFFER_NOT_OPEN');

  const acceptor = await prisma.user.findFirst({
    where: { id: acceptorId, deletedAt: null },
    select: { id: true, name: true, email: true, role: true },
  });
  if (!acceptor || acceptor.role === Role.BLOQUEADO) {
    throw new AppError(403, 'No tienes permiso para aceptar ofertas', 'ACCOUNT_BLOCKED');
  }
  await assertHasExpediente(acceptorId);

  // Fase transaccional: transición condicional + evento en el outbox
  const won = await prisma.$transaction(async (tx) => {
    const ok = await offerRepo.acceptIfOpen(offerId, acceptorId, tx);
    if (ok) {
      await publish(
        'offer.status.changed',
        {
          offerId,
          from: OfferStatus.OPEN,
          to: OfferStatus.ACCEPTED,
          actorId: acceptorId,
          asignatura: { codigo: offer.asignatura.codigo, nombre: offer.asignatura.nombre },
        },
        { audience: [offer.userId, acceptorId], tx },
      );
    }
    return ok;
  });
  // Perdió la carrera frente a otro aceptante concurrente (CA-05)
  if (!won) throw new AppError(409, 'Esta oferta ya no está disponible', 'OFFER_NOT_OPEN');
  notifyEnqueued();

  // Fase de efectos
  logAction({ userId: acceptorId, action: 'ACCEPT_OFFER', payload: { offerId, creatorId: offer.userId } }).catch(console.error);

  const creator = offer.user;
  const detalle = `Oferta: ${offer.asignatura.nombre} · ${offer.grupoActual.nombre} ↔ ${offer.grupoDeseado.nombre}`;
  // RF-OFE-09: cada parte recibe nombre y email de la contraparte
  await Promise.all([
    createNotification({
      userId: creator.id,
      asunto: 'Oferta de cambio de grupo aceptada',
      contenido: `Tu oferta ha sido aceptada.\n${detalle}\nContraparte: ${acceptor.name} (${acceptor.email})`,
      kind: 'OFFER_ACCEPTED',
      refs: { offerId },
    }),
    createNotification({
      userId: acceptor.id,
      asunto: 'Oferta de cambio de grupo aceptada',
      contenido: `Has aceptado una oferta.\n${detalle}\nContraparte: ${creator.name} (${creator.email})`,
      kind: 'OFFER_ACCEPTED',
      refs: { offerId },
    }),
  ]);

  return offerRepo.findById(offerId);
}

// ── closeOffer ────────────────────────────────────────────────

export async function closeOffer(offerId: string, requesterId: string, requesterRole: Role) {
  const offer = await offerRepo.findById(offerId);
  if (!offer) throw new AppError(404, 'Oferta no encontrada');

  const isCreator = offer.userId === requesterId;
  const isAcceptor = offer.acceptedById === requesterId;
  const isAdmin = requesterRole === Role.EMBAJADOR || requesterRole === Role.PROPIETARIO;
  if (!isCreator && !isAcceptor && !isAdmin) {
    throw new AppError(403, 'Solo el creador de la oferta, su aceptante o un administrador pueden cerrarla');
  }

  const closed = await prisma.$transaction(async (tx) => {
    const ok = await offerRepo.closeIfNotClosed(offerId, tx);
    if (ok) {
      await publish(
        'offer.status.changed',
        {
          offerId,
          from: offer.status,
          to: OfferStatus.CLOSED,
          actorId: requesterId,
          asignatura: { codigo: offer.asignatura.codigo, nombre: offer.asignatura.nombre },
        },
        { audience: [offer.userId, ...(offer.acceptedById ? [offer.acceptedById] : [])], tx },
      );
    }
    return ok;
  });
  // RF-OFE-10: una oferta cerrada no se reabre ni se vuelve a cerrar
  if (!closed) throw new AppError(409, 'La oferta ya está cerrada', 'OFFER_ALREADY_CLOSED');
  notifyEnqueued();

  logAction({ userId: requesterId, action: 'CLOSE_OFFER', payload: { offerId, byAdmin: isAdmin && !isCreator && !isAcceptor } }).catch(console.error);
  return offerRepo.findById(offerId);
}

// ── Panel de usuario ──────────────────────────────────────────

export async function getUserOffers(userId: string) {
  return offerRepo.findByUserId(userId);
}

export async function getUserOffersPage(
  userId: string,
  opts: PageOptions & { statuses?: OfferStatus[]; role?: 'creator' | 'acceptor' | 'any' },
) {
  const rows = await offerRepo.findForUser({ userId, statuses: opts.statuses, role: opts.role, limit: opts.limit, after: opts.after });
  return page(rows, opts.limit, (o) => toPanelItem(o, userId), (o) => ({ createdAt: o.createdAt, id: o.id }));
}

/** Una oferta con sus mensajes (página de chat). */
export async function getOfferById(offerId: string, requesterId: string) {
  const offer = await offerRepo.findById(offerId);
  if (!offer) throw new AppError(404, 'Oferta no encontrada');
  const isParticipant = offer.userId === requesterId || offer.acceptedById === requesterId;
  if (!isParticipant) throw new AppError(403, 'No tienes acceso a esta oferta');
  const messages = await offerRepo.findOfferMessages(offerId);
  return { ...offer, messages };
}

// ── Mensajería (RF-CHT) ───────────────────────────────────────

/**
 * Único camino para enviar un mensaje de chat de oferta, tanto por REST
 * como por socket (Arquitectura §7.1). Revalida pertenencia y estado en cada
 * mensaje (RF-CHT-07) y persiste antes de difundir (ADR-07).
 */
export async function sendMessage(offerId: string, authorId: string, rawContent: string) {
  const content = rawContent.trim();
  if (content.length < 1 || content.length > 2000) {
    throw new AppError(400, 'El mensaje debe tener entre 1 y 2000 caracteres');
  }

  const offer = await offerRepo.findById(offerId);
  if (!offer) throw new AppError(404, 'Oferta no encontrada');
  const isParticipant = offer.userId === authorId || offer.acceptedById === authorId;
  if (!isParticipant) throw new AppError(403, 'No tienes acceso a esta oferta');
  if (offer.status !== OfferStatus.ACCEPTED) {
    throw new AppError(409, 'El chat solo está disponible para ofertas aceptadas', 'CHAT_CLOSED');
  }

  const participants = [offer.userId, offer.acceptedById!];
  const message = await prisma.$transaction(async (tx) => {
    const m = await offerRepo.createOfferMessage(offerId, authorId, content, tx);
    await publish(
      'offer.message.created',
      { offerId, messageId: m.id, authorId, authorName: m.author.name, content: m.content, timestamp: m.timestamp.toISOString() },
      { audience: participants, tx },
    );
    return m;
  });
  notifyEnqueued();

  // RF-CHT-06: notificación a ambas partes
  notifyMany(
    participants.map((userId) => ({ userId })),
    'Nuevo mensaje en tu cambio de grupo',
    `Has recibido un mensaje en el chat de la oferta.\nVista previa: "${content.slice(0, 80)}"`,
    { kind: 'CHAT_MESSAGE', refs: { offerId } },
  ).catch((err) => console.error('[offer.service] error creando notificaciones de mensaje:', err));

  return message;
}
