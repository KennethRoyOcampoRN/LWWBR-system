import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPrisma = {
  user: { findFirst: vi.fn() },
  restDayRequest: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  auditLog: { create: vi.fn(), count: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
};

vi.mock('../../../src/lib/prisma.js', () => ({ prisma: mockPrisma }));

const { createApp } = await import('../../../src/app.js');
const { signAccessToken } = await import('../../../src/modules/auth/tokens.js');

function userWithRole(roleKey: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'user_1',
    employeeCode: 'LWW-011',
    fullName: 'Housekeeping Staff (Demo)',
    email: null,
    department: 'HOUSEKEEPING',
    isActive: true,
    mustChangePassword: false,
    deletedAt: null,
    roles: [{ role: { key: roleKey } }],
    ...overrides,
  };
}

function authCookie() {
  return [`lwwbr_access=${signAccessToken('user_1')}`];
}

function fakeRestDayRequest(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'restday_1',
    userId: 'user_1',
    requestedDate: new Date('2026-09-25T00:00:00.000Z'),
    reason: null,
    status: 'PENDING',
    decidedById: null,
    decidedAt: null,
    decisionNote: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    user: { id: 'user_1', fullName: 'Housekeeping Staff (Demo)' },
    decidedBy: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.auditLog.findFirst.mockResolvedValue(null);
  mockPrisma.auditLog.count.mockResolvedValue(0);
  mockPrisma.auditLog.findMany.mockResolvedValue([]);
});

describe('POST /api/v1/restday-requests', () => {
  it.each(['HOUSEKEEPING_STAFF', 'RESORT_MANAGER'])('allows %s to submit a rest-day request for themselves', async (roleKey) => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole(roleKey));
    mockPrisma.restDayRequest.create.mockResolvedValue(fakeRestDayRequest());

    const res = await request(createApp())
      .post('/api/v1/restday-requests')
      .set('Cookie', authCookie())
      .send({ requestedDate: '2026-09-25T00:00:00.000Z', reason: 'Family event' });

    expect(res.status).toBe(201);
    expect(mockPrisma.restDayRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userId: 'user_1' }) }),
    );
  });

  // restday:request is near-universal — OWNER is the one role that
  // doesn't hold it (per the real seed).
  it('refuses OWNER — does not hold restday:request', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('OWNER'));
    const res = await request(createApp())
      .post('/api/v1/restday-requests')
      .set('Cookie', authCookie())
      .send({ requestedDate: '2026-09-25T00:00:00.000Z' });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/v1/restday-requests', () => {
  it('a restday:request-only holder always sees only their own requests, regardless of query params', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('HOUSEKEEPING_STAFF'));
    mockPrisma.restDayRequest.findMany.mockResolvedValue([fakeRestDayRequest()]);

    const res = await request(createApp()).get('/api/v1/restday-requests?mine=false').set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(mockPrisma.restDayRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: 'user_1' }) }),
    );
  });

  it('a restday:approve holder sees the full queue by default (not scoped to self)', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.restDayRequest.findMany.mockResolvedValue([fakeRestDayRequest()]);

    const res = await request(createApp()).get('/api/v1/restday-requests').set('Cookie', authCookie());

    expect(res.status).toBe(200);
    const call = mockPrisma.restDayRequest.findMany.mock.calls[0]![0];
    expect(call.where.userId).toBeUndefined();
  });

  it('a restday:approve holder can still scope to their own via ?mine=true', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.restDayRequest.findMany.mockResolvedValue([]);

    await request(createApp()).get('/api/v1/restday-requests?mine=true').set('Cookie', authCookie());

    expect(mockPrisma.restDayRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: 'user_1' }) }),
    );
  });
});

describe('POST /api/v1/restday-requests/:id/status', () => {
  it('lets restday:approve mark a request APPROVED', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.restDayRequest.findFirst.mockResolvedValue(fakeRestDayRequest());
    mockPrisma.restDayRequest.update.mockResolvedValue(
      fakeRestDayRequest({ status: 'APPROVED', decidedById: 'user_1' }),
    );

    const res = await request(createApp())
      .post('/api/v1/restday-requests/restday_1/status')
      .set('Cookie', authCookie())
      .send({ toStatus: 'APPROVED' });

    expect(res.status).toBe(200);
    expect(res.body.restDayRequest.status).toBe('APPROVED');
  });

  it('lets restday:approve mark a request REJECTED with a decision note', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.restDayRequest.findFirst.mockResolvedValue(fakeRestDayRequest());
    mockPrisma.restDayRequest.update.mockResolvedValue(
      fakeRestDayRequest({ status: 'REJECTED', decisionNote: 'Short-staffed that day' }),
    );

    const res = await request(createApp())
      .post('/api/v1/restday-requests/restday_1/status')
      .set('Cookie', authCookie())
      .send({ toStatus: 'REJECTED', decisionNote: 'Short-staffed that day' });

    expect(res.status).toBe(200);
    expect(res.body.restDayRequest.status).toBe('REJECTED');
  });

  it('refuses a restday:request-only holder — cannot approve/reject even their own request', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('HOUSEKEEPING_STAFF'));
    const res = await request(createApp())
      .post('/api/v1/restday-requests/restday_1/status')
      .set('Cookie', authCookie())
      .send({ toStatus: 'APPROVED' });
    expect(res.status).toBe(403);
    expect(mockPrisma.restDayRequest.update).not.toHaveBeenCalled();
  });

  it('404s for a request that does not exist', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.restDayRequest.findFirst.mockResolvedValue(null);
    const res = await request(createApp())
      .post('/api/v1/restday-requests/missing/status')
      .set('Cookie', authCookie())
      .send({ toStatus: 'APPROVED' });
    expect(res.status).toBe(404);
  });
});
