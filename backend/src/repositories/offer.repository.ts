import { OfferStatus, Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import { CursorPosition, afterCursorWhere } from '../utils/cursor';

type Db = Prisma.TransactionClient | typeof prisma;

// Incluye las relaciones necesarias para mostrar ofertas al cliente
const OFFER_INCLUDE = {
  asignatura: { select: { id: true, nombre: true, codigo: true } },
  grupoDeseado: { select: { id: true, nombre: true } },
  grupoActual: { select: { id: true, nombre: true } },
  user: { select: { id: true, name: true, email: true } },
  acceptedBy: { select: { id: true, name: true, email: true } },
} as const;

export type OfferWithRelations = NonNullable<Awaited<ReturnType<typeof findById>>>;

export interface SearchOffersFilter {
  asignaturaId?: string;
  grupoDeseadoId?: string;
  grupoActualId?: string;
  /** Solo en modo paginado: excluye las ofertas propias (EP-C-12). */
  excludeUserId?: string;
  limit?: number;
  after?: CursorPosition | null;
}

/** Ofertas OPEN complementarias con entidades padre no eliminadas (RF-OFE-04/05, RF-ACA-07). */
export async function findActiveOffers(filter: SearchOffersFilter = {}) {
  return prisma.offer.findMany({
    where: {
      status: OfferStatus.OPEN,
      deletedAt: null,
      asignatura: { deletedAt: null, curso: { deletedAt: null, carrera: { deletedAt: null } } },
      grupoDeseado: { deletedAt: null },
      grupoActual: { deletedAt: null },
      ...(filter.asignaturaId ? { asignaturaId: filter.asignaturaId } : {}),
      // El buscador TIENE grupoActual y DESEA grupoDeseado: se buscan ofertas
      // cuyo creador TIENE grupoDeseado y DESEA grupoActual.
      ...(filter.grupoDeseadoId ? { grupoActualId: filter.grupoDeseadoId } : {}),
      ...(filter.grupoActualId ? { grupoDeseadoId: filter.grupoActualId } : {}),
      ...(filter.excludeUserId ? { userId: { not: filter.excludeUserId } } : {}),
      ...afterCursorWhere(filter.after ?? null),
    },
    include: OFFER_INCLUDE,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    ...(filter.limit ? { take: filter.limit + 1 } : {}),
  });
}

export async function findById(id: string, db: Db = prisma) {
  return db.offer.findFirst({ where: { id, deletedAt: null }, include: OFFER_INCLUDE });
}

export interface UserOffersFilter {
  userId: string;
  statuses?: OfferStatus[];
  role?: 'creator' | 'acceptor' | 'any';
  limit?: number;
  after?: CursorPosition | null;
}

/** Ofertas en las que participa el usuario (creador o aceptante). */
export async function findByUserId(userId: string) {
  return findForUser({ userId });
}

export async function findForUser(f: UserOffersFilter) {
  const roleWhere =
    f.role === 'creator' ? { userId: f.userId } : f.role === 'acceptor' ? { acceptedById: f.userId } : { OR: [{ userId: f.userId }, { acceptedById: f.userId }] };
  return prisma.offer.findMany({
    where: {
      AND: [
        roleWhere,
        { deletedAt: null },
        f.statuses?.length ? { status: { in: f.statuses } } : {},
        afterCursorWhere(f.after ?? null),
      ],
    },
    include: OFFER_INCLUDE,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    ...(f.limit ? { take: f.limit + 1 } : {}),
  });
}

export interface CreateOfferInput {
  userId: string;
  asignaturaId: string;
  grupoDeseadoId: string;
  grupoActualId: string;
}

export async function createOffer(input: CreateOfferInput, db: Db = prisma) {
  return db.offer.create({
    data: { ...input, status: OfferStatus.OPEN },
    include: OFFER_INCLUDE,
  });
}

/**
 * AR-06: transición OPEN → ACCEPTED como actualización condicional atómica.
 * Devuelve true solo para el único aceptante que gana la carrera.
 */
export async function acceptIfOpen(id: string, acceptorId: string, db: Db = prisma): Promise<boolean> {
  const { count } = await db.offer.updateMany({
    where: { id, status: OfferStatus.OPEN, deletedAt: null, userId: { not: acceptorId } },
    data: { status: OfferStatus.ACCEPTED, acceptedById: acceptorId },
  });
  return count === 1;
}

/** Cierre condicional: devuelve false si ya estaba cerrada (RF-OFE-10). */
export async function closeIfNotClosed(id: string, db: Db = prisma): Promise<boolean> {
  const { count } = await db.offer.updateMany({
    where: { id, deletedAt: null, status: { not: OfferStatus.CLOSED } },
    data: { status: OfferStatus.CLOSED },
  });
  return count === 1;
}

/** Marca como INACTIVE todas las ofertas OPEN de un usuario (al ser bloqueado). */
export async function deactivateUserOffers(userId: string, db: Db = prisma): Promise<void> {
  await db.offer.updateMany({
    where: { userId, status: OfferStatus.OPEN, deletedAt: null },
    data: { status: OfferStatus.INACTIVE },
  });
}

export async function createOfferMessage(offerId: string, authorId: string, content: string, db: Db = prisma) {
  return db.message.create({
    data: { offerId, authorId, content },
    include: { author: { select: { id: true, name: true } } },
  });
}

export async function findOfferMessages(offerId: string) {
  return prisma.message.findMany({
    where: { offerId },
    include: { author: { select: { id: true, name: true } } },
    orderBy: [{ timestamp: 'asc' }, { id: 'asc' }],
  });
}

/** Devuelve una página de mensajes de una oferta en orden cronológico ascendente (`EP-C-15`). */
export async function findOfferMessagesPage(
  offerId: string,
  opts: { limit: number; beforeId?: string },
) {
  let beforeFilter: Prisma.MessageWhereInput = {};
  if (opts.beforeId) {
    const anchor = await prisma.message.findFirst({
      where: { id: opts.beforeId, offerId },
      select: { id: true, timestamp: true },
    });
    if (anchor) {
      beforeFilter = {
        OR: [
          { timestamp: { lt: anchor.timestamp } },
          { timestamp: anchor.timestamp, id: { lt: anchor.id } },
        ],
      };
    }
  }

  const rows = await prisma.message.findMany({
    where: { offerId, ...beforeFilter },
    include: { author: { select: { id: true, name: true } } },
    orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
    take: opts.limit + 1,
  });

  const hasMore = rows.length > opts.limit;
  const items = (hasMore ? rows.slice(0, opts.limit) : rows).reverse();
  return { items, hasMore };
}
