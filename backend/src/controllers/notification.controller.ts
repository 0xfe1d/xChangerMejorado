import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { AppError } from '../middleware/errorHandler';
import * as notificationService from '../services/notification.service';

const listSchema = z.object({
  unread: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().max(200).optional(),
});

// ── GET /notifications/unread-count ───────────────────────────
export async function getUnreadCount(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json({ count: await notificationService.unreadCount(req.user!.sub) });
  } catch (err) { next(err); }
}

// ── GET /notifications ────────────────────────────────────────
// La respuesta sigue siendo un array (contrato actual); el siguiente cursor
// viaja en la cabecera X-Next-Cursor para no romper al frontend.
export async function getNotifications(req: Request, res: Response, next: NextFunction): Promise<void> {
  const parsed = listSchema.safeParse(req.query);
  if (!parsed.success) return next(new AppError(400, parsed.error.errors[0].message));
  try {
    const { items, nextCursor } = await notificationService.list(req.user!.sub, {
      unread: parsed.data.unread === 'true',
      limit: parsed.data.limit,
      cursor: parsed.data.cursor,
    });
    if (nextCursor) res.setHeader('X-Next-Cursor', nextCursor);
    res.json(items);
  } catch (err) { next(err); }
}

// ── PATCH /notifications/:id/read ─────────────────────────────
export async function markAsRead(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await notificationService.markRead(req.user!.sub, req.params.id);
    res.json({ message: 'Notificación marcada como leída' });
  } catch (err) { next(err); }
}

// ── PATCH /notifications/read-all ─────────────────────────────
export async function markAllAsRead(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await notificationService.markAllRead(req.user!.sub);
    res.json({ message: 'Todas las notificaciones marcadas como leídas' });
  } catch (err) { next(err); }
}

// ── GET / PATCH /me/notification-preferences ──────────────────
const prefsSchema = z
  .object({
    email: z.object({ enabled: z.boolean().optional() }).strict().optional(),
    telegram: z.object({ enabled: z.boolean().optional(), chatMessages: z.boolean().optional() }).strict().optional(),
  })
  .strict();

export async function getPreferences(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json(await notificationService.getPreferences(req.user!.sub));
  } catch (err) { next(err); }
}

export async function updatePreferences(req: Request, res: Response, next: NextFunction): Promise<void> {
  const parsed = prefsSchema.safeParse(req.body);
  if (!parsed.success) return next(new AppError(400, parsed.error.errors[0].message));
  try {
    res.json(await notificationService.updatePreferences(req.user!.sub, parsed.data));
  } catch (err) { next(err); }
}
