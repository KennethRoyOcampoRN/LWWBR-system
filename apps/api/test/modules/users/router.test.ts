import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPrisma = {
  user: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
  role: { findMany: vi.fn() },
  userRole: { deleteMany: vi.fn(), createMany: vi.fn() },
  session: { updateMany: vi.fn() },
  auditLog: { create: vi.fn(), count: vi.fn(), findFirst: vi.fn() },
  $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
};

vi.mock('../../../src/lib/prisma.js', () => ({ prisma: mockPrisma }));

const { createApp } = await import('../../../src/app.js');
const { signAccessToken } = await import('../../../src/modules/auth/tokens.js');

function adminUser(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'admin_1',
    employeeCode: 'LWW-001',
    fullName: 'System Admin (Demo)',
    email: null,
    phone: null,
    department: 'MANAGEMENT',
    isActive: true,
    mustChangePassword: false,
    lastLoginAt: null,
    deletedAt: null,
    roles: [{ role: { key: 'SYSTEM_ADMIN' } }],
    ...overrides,
  };
}

function authCookie() {
  const token = signAccessToken('admin_1');
  return [`lwwbr_access=${token}`];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.auditLog.findFirst.mockResolvedValue(null);
  mockPrisma.auditLog.count.mockResolvedValue(0);
  mockPrisma.$transaction.mockImplementation(async (ops: Promise<unknown>[]) => Promise.all(ops));
});

describe('GET /api/v1/users', () => {
  it('requires user:read', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(
      adminUser({ roles: [{ role: { key: 'HOUSEKEEPING_STAFF' } }] }),
    );
    const res = await request(createApp()).get('/api/v1/users').set('Cookie', authCookie());
    expect(res.status).toBe(403);
  });

  it('lists users for a caller with user:read', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(adminUser());
    mockPrisma.user.findMany.mockResolvedValue([adminUser()]);

    const res = await request(createApp()).get('/api/v1/users').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(1);
    expect(res.body.users[0].employeeCode).toBe('LWW-001');
    expect(res.body.users[0].roles).toEqual(['SYSTEM_ADMIN']);
  });
});

describe('POST /api/v1/users', () => {
  it('returns 422 on invalid body', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(adminUser());
    const res = await request(createApp())
      .post('/api/v1/users')
      .set('Cookie', authCookie())
      .send({ employeeCode: '', fullName: '', department: 'MANAGEMENT', roleKeys: [] });
    expect(res.status).toBe(422);
  });

  it('creates a user and returns a one-time temp password', async () => {
    mockPrisma.user.findFirst
      .mockResolvedValueOnce(adminUser()) // requirePermission's getMe lookup
      .mockResolvedValueOnce(null); // employeeCode uniqueness check
    mockPrisma.role.findMany.mockResolvedValue([{ id: 'role_cashier', key: 'CASHIER' }]);
    mockPrisma.user.create.mockResolvedValue(
      adminUser({
        id: 'user_new',
        employeeCode: 'LWW-020',
        fullName: 'New Hire',
        roles: [{ role: { key: 'CASHIER' } }],
      }),
    );

    const res = await request(createApp())
      .post('/api/v1/users')
      .set('Cookie', authCookie())
      .send({
        employeeCode: 'LWW-020',
        fullName: 'New Hire',
        department: 'FRONT_OFFICE',
        roleKeys: ['CASHIER'],
      });

    expect(res.status).toBe(201);
    expect(res.body.user.employeeCode).toBe('LWW-020');
    expect(typeof res.body.tempPassword).toBe('string');
    expect(res.body.tempPassword.length).toBeGreaterThan(0);
  });

  it('returns 409 when the employee code is already taken', async () => {
    mockPrisma.user.findFirst
      .mockResolvedValueOnce(adminUser())
      .mockResolvedValueOnce(adminUser({ employeeCode: 'LWW-020' }));

    const res = await request(createApp())
      .post('/api/v1/users')
      .set('Cookie', authCookie())
      .send({ employeeCode: 'LWW-020', fullName: 'Dup', department: 'FRONT_OFFICE', roleKeys: ['CASHIER'] });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMPLOYEE_CODE_TAKEN');
  });
});

describe('PATCH /api/v1/users/:id', () => {
  it('updates fields and replaces role assignments', async () => {
    mockPrisma.user.findFirst.mockResolvedValueOnce(adminUser()).mockResolvedValueOnce(adminUser({ id: 'user_1' }));
    mockPrisma.role.findMany.mockResolvedValue([{ id: 'role_manager', key: 'RESORT_MANAGER' }]);
    mockPrisma.user.update.mockResolvedValue(
      adminUser({ id: 'user_1', fullName: 'Updated Name', roles: [{ role: { key: 'RESORT_MANAGER' } }] }),
    );

    const res = await request(createApp())
      .patch('/api/v1/users/user_1')
      .set('Cookie', authCookie())
      .send({ fullName: 'Updated Name', roleKeys: ['RESORT_MANAGER'] });

    expect(res.status).toBe(200);
    expect(res.body.user.fullName).toBe('Updated Name');
    expect(mockPrisma.userRole.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user_1' } });
    expect(mockPrisma.userRole.createMany).toHaveBeenCalledWith({
      data: [{ userId: 'user_1', roleId: 'role_manager' }],
    });
  });

  it('returns 404 for an unknown user', async () => {
    mockPrisma.user.findFirst.mockResolvedValueOnce(adminUser()).mockResolvedValueOnce(null);

    const res = await request(createApp())
      .patch('/api/v1/users/does_not_exist')
      .set('Cookie', authCookie())
      .send({ fullName: 'X' });

    expect(res.status).toBe(404);
  });
});

describe('POST /api/v1/users/:id/reset-password', () => {
  it('issues a new temp password and revokes active sessions', async () => {
    mockPrisma.user.findFirst.mockResolvedValueOnce(adminUser()).mockResolvedValueOnce(adminUser({ id: 'user_1' }));
    mockPrisma.user.update.mockResolvedValue(adminUser({ id: 'user_1' }));

    const res = await request(createApp())
      .post('/api/v1/users/user_1/reset-password')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(typeof res.body.tempPassword).toBe('string');
    expect(mockPrisma.session.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user_1', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });
});
