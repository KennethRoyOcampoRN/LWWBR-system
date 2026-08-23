import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPrisma = {
  notification: { findMany: vi.fn(), updateMany: vi.fn() },
  auditLog: { create: vi.fn(), count: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
};

vi.mock('../../../src/lib/prisma.js', () => ({ prisma: mockPrisma }));

const { createApp } = await import('../../../src/app.js');
const { signAccessToken } = await import('../../../src/modules/auth/tokens.js');

function authCookie() {
  return [`lwwbr_access=${signAccessToken('user_1')}`];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.auditLog.findFirst.mockResolvedValue(null);
  mockPrisma.auditLog.count.mockResolvedValue(0);
  mockPrisma.auditLog.findMany.mockResolvedValue([]);
});

describe('GET /api/v1/notifications', () => {
  it('requires authentication', async () => {
    const res = await request(createApp()).get('/api/v1/notifications');
    expect(res.status).toBe(401);
  });

  it('scopes to the caller\'s own notifications, newest first', async () => {
    mockPrisma.notification.findMany.mockResolvedValue([{ id: 'notif_1' }]);

    const res = await request(createApp()).get('/api/v1/notifications').set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.notifications).toEqual([{ id: 'notif_1' }]);
    expect(mockPrisma.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user_1' }, orderBy: { createdAt: 'desc' } }),
    );
  });

  it('?unread=true narrows to readAt: null', async () => {
    mockPrisma.notification.findMany.mockResolvedValue([]);

    const res = await request(createApp()).get('/api/v1/notifications?unread=true').set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(mockPrisma.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user_1', readAt: null } }),
    );
  });
});

describe('POST /api/v1/notifications/:id/read', () => {
  it('requires authentication', async () => {
    const res = await request(createApp()).post('/api/v1/notifications/notif_1/read');
    expect(res.status).toBe(401);
  });

  it('marks the caller\'s own notification read', async () => {
    mockPrisma.notification.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(createApp()).post('/api/v1/notifications/notif_1/read').set('Cookie', authCookie());

    expect(res.status).toBe(204);
    expect(mockPrisma.notification.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'notif_1', userId: 'user_1' } }),
    );
  });

  it('404s for a notification that does not belong to the caller (scoped by userId in the query itself, not a separate ownership check)', async () => {
    mockPrisma.notification.updateMany.mockResolvedValue({ count: 0 });

    const res = await request(createApp()).post('/api/v1/notifications/someone_elses/read').set('Cookie', authCookie());

    expect(res.status).toBe(404);
  });
});
