import { NotificationChannel } from '@prisma/client';
import { prisma } from '../config/prisma';

export interface ListNotificationsFilter {
  userId: string;
  unread?: boolean;
  limit?: number;
  before?: { timestamp: Date; id: string } | null;
}

export async function listForUser(f: ListNotificationsFilter) {
  return prisma.notification.findMany({
    where: {
      userId: f.userId,
      ...(f.unread ? { isRead: false } : {}),
      ...(f.before
        ? { OR: [{ timestamp: { lt: f.before.timestamp } }, { timestamp: f.before.timestamp, id: { lt: f.before.id } }] }
        : {}),
    },
    orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
    ...(f.limit ? { take: f.limit + 1 } : {}),
  });
}

export const countUnread = (userId: string) => prisma.notification.count({ where: { userId, isRead: false } });

export const markRead = (userId: string, id: string) =>
  prisma.notification.updateMany({ where: { id, userId }, data: { isRead: true } });

export const markAllRead = (userId: string) =>
  prisma.notification.updateMany({ where: { userId, isRead: false }, data: { isRead: true } });

export async function getPreferences(userId: string) {
  return prisma.notificationPreference.findMany({ where: { userId } });
}

export async function upsertPreference(userId: string, channel: NotificationChannel, data: { enabled?: boolean; chatMessages?: boolean }) {
  return prisma.notificationPreference.upsert({
    where: { userId_channel: { userId, channel } },
    create: { userId, channel, enabled: data.enabled ?? true, chatMessages: data.chatMessages ?? true },
    update: data,
  });
}
