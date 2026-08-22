import { Router } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hashPassword } from '../../../src/modules/auth/passwords.js';

const mockPrisma = {
  user: { findFirst: vi.fn(), update: vi.fn() },
  session: { create: vi.fn(), findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  auditLog: { create: vi.fn(), count: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
};

vi.mock('../../../src/lib/prisma.js', () => ({ prisma: mockPrisma }));

const { createApp } = await import('../../../src/app.js');
const { requirePermission } = await import('../../../src/modules/auth/requirePermission.js');
const { signAccessToken } = await import('../../../src/modules/auth/tokens.js');

function fakeUser(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'user_1',
    employeeCode: 'LWW-006',
    fullName: 'Cashier (Demo)',
    email: null,
    department: 'FRONT_OFFICE',
    isActive: true,
    mustChangePassword: true,
    deletedAt: null,
    roles: [{ role: { key: 'CASHIER' } }],
    ...overrides,
  };
}

// A tiny protected route mounted via createApp()'s extraRouters option
// (before the app's own 404 handler), exercising requirePermission
// through actual Express middleware composition — not calling the
// function directly — including reading the cookie via the app's own
// cookieParser.
function appWithProtectedRoute() {
  const testRouter = Router();
  testRouter.get('/api/v1/__test/protected', requirePermission('payment:submit'), (req, res) => {
    res.json({ ok: true, scope: req.permissionScope, department: req.authUser?.department });
  });
  return createApp({ extraRouters: [testRouter] });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.auditLog.findFirst.mockResolvedValue(null);
  mockPrisma.auditLog.count.mockResolvedValue(0);
  mockPrisma.auditLog.findMany.mockResolvedValue([]);
});

describe('requirePermission', () => {
  it('returns 401 with no session', async () => {
    const res = await request(appWithProtectedRoute()).get('/api/v1/__test/protected');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('returns 403 when authenticated but lacking the permission', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(
      fakeUser({ roles: [{ role: { key: 'HOUSEKEEPING_STAFF' } }] }), // has no payment:submit
    );
    const token = signAccessToken('user_1');

    const res = await request(appWithProtectedRoute())
      .get('/api/v1/__test/protected')
      .set('Cookie', [`lwwbr_access=${token}`]);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('allows the request through and attaches authUser/permissionScope when granted', async () => {
    const passwordHash = await hashPassword('Waku2026!');
    mockPrisma.user.findFirst.mockResolvedValue(fakeUser({ passwordHash }));

    const agent = request.agent(appWithProtectedRoute());
    await agent.post('/api/v1/auth/login').send({ employeeCode: 'LWW-006', password: 'Waku2026!' });

    const res = await agent.get('/api/v1/__test/protected');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, scope: 'ALL', department: 'FRONT_OFFICE' });
  });

  it('returns 403 for a DEPARTMENT-scoped permission the caller does not hold at all (not just narrower scope)', async () => {
    // POC_HOUSEKEEPING has workorder:read_all at DEPARTMENT scope, not
    // payment:submit at any scope — this exercises "scope exists but for
    // a different key" being correctly treated as no grant.
    mockPrisma.user.findFirst.mockResolvedValue(
      fakeUser({ roles: [{ role: { key: 'POC_HOUSEKEEPING' } }] }),
    );
    const token = signAccessToken('user_1');

    const res = await request(appWithProtectedRoute())
      .get('/api/v1/__test/protected')
      .set('Cookie', [`lwwbr_access=${token}`]);

    expect(res.status).toBe(403);
  });
});
