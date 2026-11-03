import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { OfferStatus } from '@prisma/client';
import { AppError } from '../middleware/errorHandler';
import * as offerService from '../services/offer.service';
import { decodeCursor } from '../utils/cursor';

// ── Esquemas de validación ────────────────────────────────────

const createSchema = z.object({
  asignaturaId: z.string().cuid(),
  grupoDeseadoId: z.string().cuid(),
  grupoActualId: z.string().cuid(),
});

const searchSchema = z.object({
  asignaturaId: z.string().cuid().optional(),
  grupoDeseadoId: z.string().cuid().optional(),
  grupoActualId: z.string().cuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().max(200).optional(),
});

const myOffersSchema = z.object({
  status: z
    .string()
    .transform((s) => s.split(',').map((v) => v.trim().toUpperCase()))
    .pipe(z.array(z.nativeEnum(OfferStatus)).min(1))
    .optional(),
  role: z.enum(['creator', 'acceptor', 'any']).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().max(200).optional(),
});

const idSchema = z.string().cuid();

function parseCursor(raw: string | undefined) {
  if (!raw) return null;
  const pos = decodeCursor(raw);
  if (!pos) throw new AppError(400, 'Cursor inválido', 'VALIDATION_ERROR');
  return pos;
}

function requireId(req: Request): string {
  if (!idSchema.safeParse(req.params.id).success) throw new AppError(400, 'Identificador inválido');
  return req.params.id;
}

/** Por defecto un canal recibe 10 resultados; la web mantiene el formato completo (EP-C-12). */
const CHANNEL_DEFAULT_LIMIT = 10;

// ── GET /offers ───────────────────────────────────────────────

export async function listOffers(req: Request, res: Response, next: NextFunction): Promise<void> {
  const parsed = searchSchema.safeParse(req.query);
  if (!parsed.success) return next(new AppError(400, parsed.error.errors[0].message));
  const { limit, cursor, ...filter } = parsed.data;

  try {
    if (filter.grupoActualId && filter.grupoActualId === filter.grupoDeseadoId) {
      throw new AppError(400, 'El grupo actual y el deseado deben ser distintos');
    }
    const effectiveLimit = limit ?? (req.user!.client === 'channel' ? CHANNEL_DEFAULT_LIMIT : undefined);
    if (effectiveLimit) {
      res.json(await offerService.searchPage(filter, req.user!.sub, { limit: effectiveLimit, after: parseCursor(cursor) }));
      return;
    }
    res.json(await offerService.search(filter));
  } catch (err) {
    next(err);
  }
}

// ── POST /offers ──────────────────────────────────────────────

export async function createOffer(req: Request, res: Response, next: NextFunction): Promise<void> {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return next(new AppError(400, parsed.error.errors[0].message));
  try {
    const offer = await offerService.create({ userId: req.user!.sub, ...parsed.data });
    res.status(201).json(offer);
  } catch (err) {
    next(err);
  }
}

// ── POST /offers/:id/accept ───────────────────────────────────

export async function acceptOffer(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json(await offerService.acceptOffer(requireId(req), req.user!.sub));
  } catch (err) {
    next(err);
  }
}

// ── PATCH /offers/:id/close ───────────────────────────────────

export async function closeOffer(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json(await offerService.closeOffer(requireId(req), req.user!.sub, req.user!.role));
  } catch (err) {
    next(err);
  }
}

// ── GET /offers/me ────────────────────────────────────────────

export async function myOffers(req: Request, res: Response, next: NextFunction): Promise<void> {
  const parsed = myOffersSchema.safeParse(req.query);
  if (!parsed.success) return next(new AppError(400, parsed.error.errors[0].message));
  const { status, role, limit, cursor } = parsed.data;

  try {
    // Sin parámetros nuevos ni canal, el formato actual no cambia
    const paged = limit || cursor || status || role || req.user!.client === 'channel';
    if (paged) {
      res.json(
        await offerService.getUserOffersPage(req.user!.sub, {
          statuses: status,
          role,
          limit: limit ?? CHANNEL_DEFAULT_LIMIT,
          after: parseCursor(cursor),
        }),
      );
      return;
    }
    res.json(await offerService.getUserOffers(req.user!.sub));
  } catch (err) {
    next(err);
  }
}

// ── GET /offers/:id ───────────────────────────────────────────

export async function getOffer(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json(await offerService.getOfferById(requireId(req), req.user!.sub));
  } catch (err) {
    next(err);
  }
}

// ── POST /offers/:id/messages ─────────────────────────────────

const messageSchema = z.object({ content: z.string() });

export async function sendOfferMessage(req: Request, res: Response, next: NextFunction): Promise<void> {
  const parsed = messageSchema.safeParse(req.body);
  if (!parsed.success) return next(new AppError(400, parsed.error.errors[0].message));
  try {
    const msg = await offerService.sendMessage(requireId(req), req.user!.sub, parsed.data.content);
    res.status(201).json({ ...msg, authorId: msg.authorId });
  } catch (err) {
    next(err);
  }
}
