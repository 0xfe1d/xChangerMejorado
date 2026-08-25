import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { TicketStatus } from '@prisma/client';
import { AppError } from '../middleware/errorHandler';
import * as ticketService from '../services/ticket.service';

const openSchema = z.object({
  asunto: z.string().min(3).max(200),
  mensaje: z.string().min(1).max(2000).optional(),
});

const messageSchema = z.object({
  content: z.string().min(1).max(2000),
});

const adminQuerySchema = z.object({
  status: z.nativeEnum(TicketStatus).optional(),
  asuntoFilter: z.string().optional(),
  userFilter: z.string().optional(),
});

// ── POST /api/tickets ─────────────────────────────────────────

export async function openTicket(req: Request, res: Response, next: NextFunction): Promise<void> {
  const parsed = openSchema.safeParse(req.body);
  if (!parsed.success) return next(new AppError(400, parsed.error.errors[0].message));

  try {
    const ticket = await ticketService.openTicket(req.user!.sub, parsed.data.asunto, parsed.data.mensaje);
    res.status(201).json(ticket);
  } catch (err) {
    next(err);
  }
}

// ── GET /api/tickets/me ───────────────────────────────────────

export async function myTickets(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tickets = await ticketService.getMyTickets(req.user!.sub);
    res.json(tickets);
  } catch (err) {
    next(err);
  }
}

// ── GET /api/tickets/:id ──────────────────────────────────────

export async function getTicket(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const ticket = await ticketService.getTicketDetail(
      req.params.id,
      req.user!.sub,
      req.user!.role,
    );
    res.json(ticket);
  } catch (err) {
    next(err);
  }
}

// ── PATCH /api/tickets/:id/close ──────────────────────────────

export async function closeTicket(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const ticket = await ticketService.closeTicket(
      req.params.id,
      req.user!.sub,
      req.user!.role,
    );
    res.json(ticket);
  } catch (err) {
    next(err);
  }
}

// ── POST /api/tickets/:id/messages ────────────────────────────

export async function sendMessage(req: Request, res: Response, next: NextFunction): Promise<void> {
  const parsed = messageSchema.safeParse(req.body);
  if (!parsed.success) return next(new AppError(400, parsed.error.errors[0].message));

  try {
    const message = await ticketService.sendTicketMessage(
      req.params.id,
      req.user!.sub,
      parsed.data.content,
      req.user!.role,
    );
    res.status(201).json(message);
  } catch (err) {
    next(err);
  }
}

// ── GET /api/tickets/admin ────────────────────────────────────

export async function adminTickets(req: Request, res: Response, next: NextFunction): Promise<void> {
  const parsed = adminQuerySchema.safeParse(req.query);
  if (!parsed.success) return next(new AppError(400, parsed.error.errors[0].message));

  try {
    const tickets = await ticketService.getAdminTickets(
      req.user!.sub,
      req.user!.role,
      parsed.data,
    );
    res.json(tickets);
  } catch (err) {
    next(err);
  }
}
