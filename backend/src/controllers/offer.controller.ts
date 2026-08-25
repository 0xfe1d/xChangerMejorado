import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { AppError } from '../middleware/errorHandler';
import * as offerService from '../services/offer.service';

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
});

// ── GET /api/offers ───────────────────────────────────────────

export async function listOffers(req: Request, res: Response, next: NextFunction): Promise<void> {
  const parsed = searchSchema.safeParse(req.query);
  if (!parsed.success) {
    return next(new AppError(400, parsed.error.errors[0].message));
  }

  try {
    const offers = await offerService.search(parsed.data);
    res.json(offers);
  } catch (err) {
    next(err);
  }
}

// ── POST /api/offers ──────────────────────────────────────────

export async function createOffer(req: Request, res: Response, next: NextFunction): Promise<void> {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return next(new AppError(400, parsed.error.errors[0].message));
  }

  try {
    const offer = await offerService.create({
      userId: req.user!.sub,
      ...parsed.data,
    });
    res.status(201).json(offer);
  } catch (err) {
    next(err);
  }
}

// ── POST /api/offers/:id/accept ───────────────────────────────

export async function acceptOffer(req: Request, res: Response, next: NextFunction): Promise<void> {
  const { id } = req.params;

  try {
    const offer = await offerService.acceptOffer(id, req.user!.sub);
    res.json(offer);
  } catch (err) {
    next(err);
  }
}

// ── PATCH /api/offers/:id/close ───────────────────────────────

export async function closeOffer(req: Request, res: Response, next: NextFunction): Promise<void> {
  const { id } = req.params;

  try {
    const offer = await offerService.closeOffer(id, req.user!.sub, req.user!.role);
    res.json(offer);
  } catch (err) {
    next(err);
  }
}

// ── GET /api/offers/me ────────────────────────────────────────

export async function myOffers(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const offers = await offerService.getUserOffers(req.user!.sub);
    res.json(offers);
  } catch (err) {
    next(err);
  }
}
// ── GET /api/offers/:id ────────────────────────────────────

export async function getOffer(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const offer = await offerService.getOfferById(req.params.id, req.user!.sub);
    res.json(offer);
  } catch (err) {
    next(err);
  }
}

// ── POST /api/offers/:id/messages (REST fallback para el chat) ─────

const messageSchema = z.object({ content: z.string().min(1).max(2000) });

export async function sendOfferMessage(req: Request, res: Response, next: NextFunction): Promise<void> {
  const parsed = messageSchema.safeParse(req.body);
  if (!parsed.success) return next(new AppError(400, parsed.error.errors[0].message));
  try {
    const msg = await offerService.sendMessage(req.params.id, req.user!.sub, parsed.data.content);
    res.status(201).json(msg);
  } catch (err) {
    next(err);
  }
}