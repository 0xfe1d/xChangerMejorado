import { Request, Response, NextFunction } from 'express';
import { prisma } from '../config/prisma';

// ── GET /api/notifications/unread-count ──────────────────────

export async function getUnreadCount(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const count = await prisma.notification.count({
      where: { userId: req.user!.sub, isRead: false },
    });
    res.json({ count });
  } catch (err) { next(err); }
}

// ── GET /api/notifications ────────────────────────────────────

export async function getNotifications(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const notifications = await prisma.notification.findMany({
      where: { userId: req.user!.sub },
      orderBy: { timestamp: 'desc' },
    });
    res.json(notifications);
  } catch (err) {
    next(err);
  }
}

// ── PATCH /api/notifications/:id/read ────────────────────────

export async function markAsRead(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await prisma.notification.updateMany({
      where: { id: req.params.id, userId: req.user!.sub },
      data: { isRead: true },
    });
    res.json({ message: 'Notificación marcada como leída' });
  } catch (err) {
    next(err);
  }
}

// ── PATCH /api/notifications/read-all ────────────────────────

export async function markAllAsRead(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await prisma.notification.updateMany({
      where: { userId: req.user!.sub, isRead: false },
      data: { isRead: true },
    });
    res.json({ message: 'Todas las notificaciones marcadas como leídas' });
  } catch (err) {
    next(err);
  }
}
