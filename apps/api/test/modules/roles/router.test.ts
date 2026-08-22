import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPrisma = {
  user: { findFirst: vi.fn() },
  role: { findFirst: vi.fn(), findFirstOrThrow: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
  permission: { findMany: vi.fn() },
  rolePermission: { deleteMany: vi.fn(), createMany: vi.fn() },
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
    department: 'MANAGEMENT',
    isActive: true,
    mustChangePassword: false,
    deletedAt: null,
    roles: [{ role: { key: 'SYSTEM_ADMIN' } }],
    ...overrides,
  };
}

function authCookie() {
  return [`lwwbr_access=${signAccessToken('admin_1')}`];
}

function fakeRole(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'role_1',
    key: 'CASHIER',
    label: 'Cashier',
    description: null,
    isSystem: true,
    permissions: [{ scope: 'ALL', permission: { key: 'payment:submit' } }],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.auditLog.findFirst.mockResolvedValue(null);
  mockPrisma.auditLog.count.mockResolvedValue(0);
  mockPrisma.$transaction.mockImplementation(async (ops: Promise<unknown>[]) => Promise.all(ops));
});

describe('GET /api/v1/roles', () => {
  it('requires role:manage', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(adminUser({ roles: [{ role: { key: 'CASHIER' } }] }));
    const res = await request(createApp()).get('/api/v1/roles').set('Cookie', authCookie());
    expect(res.status).toBe(403);
  });

  it('lists roles with their permission grants', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(adminUser());
    mockPrisma.role.findMany.mockResolvedValue([fakeRole()]);

    const res = await request(createApp()).get('/api/v1/roles').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.roles).toEqual([
      {
        id: 'role_1',
        key: 'CASHIER',
        label: 'Cashier',
        description: null,
        isSystem: true,
        permissions: { 'payment:submit': 'ALL' },
      },
    ]);
  });
});

describe('POST /api/v1/roles', () => {
  it('creates a custom role', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(adminUser());
    mockPrisma.role.findFirst.mockResolvedValue(null);
    mockPrisma.role.create.mockResolvedValue(
      fakeRole({ id: 'role_new', key: 'NIGHT_AUDITOR', label: 'Night Auditor', isSystem: false, permissions: [] }),
    );

    const res = await request(createApp())
      .post('/api/v1/roles')
      .set('Cookie', authCookie())
      .send({ key: 'NIGHT_AUDITOR', label: 'Night Auditor' });

    expect(res.status).toBe(201);
    expect(res.body.role.key).toBe('NIGHT_AUDITOR');
    expect(res.body.role.isSystem).toBe(false);
  });

  it('returns 422 for a lowercase role key', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(adminUser());
    const res = await request(createApp())
      .post('/api/v1/roles')
      .set('Cookie', authCookie())
      .send({ key: 'night_auditor', label: 'Night Auditor' });
    expect(res.status).toBe(422);
  });

  it('returns 409 when the role key is already in use', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(adminUser());
    mockPrisma.role.findFirst.mockResolvedValue(fakeRole());
    const res = await request(createApp())
      .post('/api/v1/roles')
      .set('Cookie', authCookie())
      .send({ key: 'CASHIER', label: 'Cashier Again' });
    expect(res.status).toBe(409);
  });
});

describe('PUT /api/v1/roles/:id/permissions', () => {
  it('replaces the role permission set', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(adminUser());
    mockPrisma.role.findFirst.mockResolvedValue(fakeRole());
    mockPrisma.permission.findMany.mockResolvedValue([{ id: 'perm_1', key: 'payment:submit' }]);
    mockPrisma.role.findFirstOrThrow.mockResolvedValue(fakeRole());

    const res = await request(createApp())
      .put('/api/v1/roles/role_1/permissions')
      .set('Cookie', authCookie())
      .send({ grants: [{ permissionKey: 'payment:submit', scope: 'ALL' }] });

    expect(res.status).toBe(200);
    expect(mockPrisma.rolePermission.deleteMany).toHaveBeenCalledWith({ where: { roleId: 'role_1' } });
    expect(mockPrisma.rolePermission.createMany).toHaveBeenCalledWith({
      data: [{ roleId: 'role_1', permissionId: 'perm_1', scope: 'ALL' }],
    });
  });

  it('returns 404 for an unknown role', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(adminUser());
    mockPrisma.role.findFirst.mockResolvedValue(null);

    const res = await request(createApp())
      .put('/api/v1/roles/does_not_exist/permissions')
      .set('Cookie', authCookie())
      .send({ grants: [] });

    expect(res.status).toBe(404);
  });
});

describe('GET /api/v1/permissions', () => {
  it('lists all permissions', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(adminUser());
    mockPrisma.permission.findMany.mockResolvedValue([
      { key: 'payment:submit', group: 'payment', description: null },
    ]);

    const res = await request(createApp()).get('/api/v1/permissions').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.permissions).toEqual([{ key: 'payment:submit', group: 'payment', description: null }]);
  });
});
