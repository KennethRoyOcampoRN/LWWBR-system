import type { NotificationType } from '@prisma/client';
import type { DepartmentKey } from '@lwwbr/shared';
import { getRealtimeAdapter } from '../../adapters/realtime/index.js';
import { ApiError } from '../../lib/apiError.js';
import { prisma } from '../../lib/prisma.js';
import type { ListNotificationsQuery } from './schema.js';

interface NotificationInput {
  type: NotificationType;
  title: string;
  body: string;
  entityType?: string;
  entityId?: string;
}

// Spec §9.1: channel naming is `user:{id}` / `dept:{department}` /
// `property`. This module is the single writer of Notification rows and
// the single caller of these two channels — every domain module that
// wants to notify someone goes through here rather than writing its own
// Notification row + emit() pair, so the two can never drift apart (the
// same "never duplicate this logic" rule §7 states for transition tables
// applies just as much to "how a notification reaches a user").

/**
 * Notifies a single user: writes the Notification row, then best-effort
 * broadcasts it on that user's own `user:{id}` channel (spec §9.1's
 * `notification.new` event) so an open tab updates without a refetch.
 * The broadcast is deliberately best-effort — a Realtime outage must
 * never stop the notification from existing; it just won't show up live
 * until the recipient's next fetch/poll.
 */
export async function notifyUser(userId: string, actorId: string, input: NotificationInput): Promise<void> {
  const notification = await prisma.notification.create({
    data: {
      userId,
      type: input.type,
      title: input.title,
      body: input.body,
      entityType: input.entityType,
      entityId: input.entityId,
    },
  });

  try {
    await getRealtimeAdapter().emit(`user:${userId}`, 'notification.new', {
      entityId: notification.id,
      actorId,
      at: notification.createdAt.toISOString(),
      summary: notification.title,
      type: notification.type,
      title: notification.title,
      body: notification.body,
      relatedEntityType: notification.entityType,
      relatedEntityId: notification.entityId,
    });
  } catch (error) {
    console.error(`Realtime broadcast for notification.new (user:${userId}) failed:`, error);
  }
}

/**
 * Notifies every active user in a department: one Notification row per
 * recipient (so each person's own notification list/read state is
 * independent), plus a single best-effort broadcast on the shared
 * `dept:{department}` channel — spec §7.2's "urgent work orders push a
 * realtime notification to everyone in the target department
 * immediately" reads as one channel everyone in that department has
 * already joined on connect (§9.1), not N individual user-channel sends.
 * `excludeUserId` skips notifying the actor about their own action.
 */
export async function notifyDepartment(
  department: DepartmentKey,
  actorId: string,
  input: NotificationInput,
  excludeUserId?: string,
): Promise<void> {
  const recipients = await prisma.user.findMany({
    where: { department, isActive: true, deletedAt: null, ...(excludeUserId ? { id: { not: excludeUserId } } : {}) },
    select: { id: true },
  });
  if (recipients.length === 0) {
    return;
  }

  await prisma.notification.createMany({
    data: recipients.map((r) => ({
      userId: r.id,
      type: input.type,
      title: input.title,
      body: input.body,
      entityType: input.entityType,
      entityId: input.entityId,
    })),
  });

  try {
    await getRealtimeAdapter().emit(`dept:${department}`, 'notification.new', {
      entityId: input.entityId ?? department,
      actorId,
      at: new Date().toISOString(),
      summary: input.title,
      type: input.type,
      title: input.title,
      body: input.body,
      relatedEntityType: input.entityType,
      relatedEntityId: input.entityId,
    });
  } catch (error) {
    console.error(`Realtime broadcast for notification.new (dept:${department}) failed:`, error);
  }
}

export async function listNotifications(userId: string, query: ListNotificationsQuery) {
  return prisma.notification.findMany({
    where: { userId, ...(query.unread ? { readAt: null } : {}) },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
}

export async function markNotificationRead(id: string, userId: string): Promise<void> {
  // Scoped by userId in the where clause itself (not a separate ownership
  // check after a plain findUnique) — same "guessing another id 404s"
  // pattern SessionsPage's revoke endpoint (M1) already established for
  // self-service, per-user resources.
  const result = await prisma.notification.updateMany({
    where: { id, userId },
    data: { readAt: new Date() },
  });
  if (result.count === 0) {
    throw new ApiError(404, 'NOT_FOUND', 'Notification not found');
  }
}
