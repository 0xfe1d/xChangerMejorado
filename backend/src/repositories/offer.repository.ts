import { Offer, OfferStatus } from '@prisma/client';
import { prisma } from '../config/prisma';

// Incluye las relaciones necesarias para mostrar ofertas al cliente
const OFFER_INCLUDE = {
  asignatura: { select: { id: true, nombre: true, codigo: true } },
  grupoDeseado: { select: { id: true, nombre: true } },
  grupoActual: { select: { id: true, nombre: true } },
  user: { select: { id: true, name: true, email: true } },
  acceptedBy: { select: { id: true, name: true, email: true } },
} as const;

export type OfferWithRelations = Awaited<ReturnType<typeof findById>>;

export interface SearchOffersFilter {
  asignaturaId?: string;
  grupoDeseadoId?: string;
  grupoActualId?: string;
}

/** Devuelve ofertas OPEN con entidades padre no eliminadas (Soft Delete en cascada lógica) */
export async function findActiveOffers(filter: SearchOffersFilter = {}) {
  return prisma.offer.findMany({
    where: {
      status: OfferStatus.OPEN,
      deletedAt: null,
      // Excluye ofertas cuya asignatura o grupos hayan sido eliminados lógicamente
      asignatura: { deletedAt: null },
      grupoDeseado: { deletedAt: null },
      grupoActual: { deletedAt: null },
      ...(filter.asignaturaId ? { asignaturaId: filter.asignaturaId } : {}),
      // Búsqueda complementaria: el buscador TIENE grupoActual y DESEA grupoDeseado,
      // por lo que buscamos ofertas cuyo creador TIENE grupoDeseado y DESEA grupoActual.
      ...(filter.grupoDeseadoId ? { grupoActualId: filter.grupoDeseadoId } : {}),
      ...(filter.grupoActualId ? { grupoDeseadoId: filter.grupoActualId } : {}),
    },
    include: OFFER_INCLUDE,
    orderBy: { createdAt: 'desc' },
  });
}

export async function findById(id: string) {
  return prisma.offer.findFirst({
    where: { id, deletedAt: null },
    include: OFFER_INCLUDE,
  });
}

/** Todas las ofertas en las que el usuario participa (creador o aceptante) */
export async function findByUserId(userId: string) {
  return prisma.offer.findMany({
    where: {
      OR: [{ userId }, { acceptedById: userId }],
      deletedAt: null,
    },
    include: OFFER_INCLUDE,
    orderBy: { createdAt: 'desc' },
  });
}

export interface CreateOfferInput {
  userId: string;
  asignaturaId: string;
  grupoDeseadoId: string;
  grupoActualId: string;
}

export async function createOffer(input: CreateOfferInput) {
  return prisma.offer.create({
    data: {
      userId: input.userId,
      asignaturaId: input.asignaturaId,
      grupoDeseadoId: input.grupoDeseadoId,
      grupoActualId: input.grupoActualId,
      status: OfferStatus.OPEN,
    },
    include: OFFER_INCLUDE,
  });
}

export async function updateStatus(
  id: string,
  status: OfferStatus,
  acceptedById?: string,
): Promise<Offer> {
  return prisma.offer.update({
    where: { id },
    data: {
      status,
      ...(acceptedById !== undefined ? { acceptedById } : {}),
    },
  });
}

/** Marca como INACTIVE todas las ofertas OPEN de un usuario (al ser bloqueado) */
export async function deactivateUserOffers(userId: string): Promise<void> {
  await prisma.offer.updateMany({
    where: { userId, status: OfferStatus.OPEN, deletedAt: null },
    data: { status: OfferStatus.INACTIVE },
  });
}
