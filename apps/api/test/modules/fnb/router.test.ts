import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPrisma = {
  user: { findFirst: vi.fn() },
  menuItem: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  auditLog: { create: vi.fn(), count: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
};

vi.mock('../../../src/lib/prisma.js', () => ({ prisma: mockPrisma }));

const { createApp } = await import('../../../src/app.js');
const { signAccessToken } = await import('../../../src/modules/auth/tokens.js');

function userWithRole(roleKey: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'user_1',
    employeeCode: 'LWW-014',
    fullName: 'Restaurant Manager (Demo)',
    email: null,
    department: 'RESTAURANT',
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

function fakeMenuItem(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'menu_1',
    name: 'Sisig',
    category: 'Main',
    price: 250,
    isAvailable: true,
    prepMinutes: 15,
    sortOrder: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.auditLog.findFirst.mockResolvedValue(null);
  mockPrisma.auditLog.count.mockResolvedValue(0);
  mockPrisma.auditLog.findMany.mockResolvedValue([]);
});

describe('GET /api/v1/menu-items', () => {
  // MAINTENANCE_STAFF holds no fnb:* key at all.
  it('requires fnb:read', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('MAINTENANCE_STAFF'));
    const res = await request(createApp()).get('/api/v1/menu-items').set('Cookie', authCookie());
    expect(res.status).toBe(403);
  });

  it('lists menu items with price as a plain number', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
    mockPrisma.menuItem.findMany.mockResolvedValue([fakeMenuItem()]);

    const res = await request(createApp()).get('/api/v1/menu-items').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.menuItems).toHaveLength(1);
    expect(res.body.menuItems[0].price).toBe(250);
    expect(typeof res.body.menuItems[0].price).toBe('number');
  });
});

describe('POST /api/v1/menu-items', () => {
  // ADMIN_STAFF holds fnb:read (can see the menu) but not
  // fnb:manage_menu (can't edit it) — the read/manage split this route
  // pair exists to enforce.
  it('requires fnb:manage_menu, not just fnb:read', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
    const res = await request(createApp())
      .post('/api/v1/menu-items')
      .set('Cookie', authCookie())
      .send({ name: 'Lechon Kawali', category: 'Main', price: 280 });
    expect(res.status).toBe(403);
  });

  it('creates a menu item, defaulting isAvailable and sortOrder', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESTAURANT_MANAGER'));
    mockPrisma.menuItem.create.mockResolvedValue(
      fakeMenuItem({ name: 'Lechon Kawali', category: 'Main', price: 280, prepMinutes: undefined, sortOrder: 0 }),
    );

    const res = await request(createApp())
      .post('/api/v1/menu-items')
      .set('Cookie', authCookie())
      .send({ name: 'Lechon Kawali', category: 'Main', price: 280 });

    expect(res.status).toBe(201);
    expect(mockPrisma.menuItem.create).toHaveBeenCalledWith({
      data: {
        name: 'Lechon Kawali',
        category: 'Main',
        price: 280,
        isAvailable: true,
        prepMinutes: undefined,
        sortOrder: 0,
      },
    });
    expect(res.body.menuItem.price).toBe(280);
  });

  it('rejects a negative price', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESTAURANT_MANAGER'));
    const res = await request(createApp())
      .post('/api/v1/menu-items')
      .set('Cookie', authCookie())
      .send({ name: 'Free Soup', category: 'Soup', price: -1 });
    expect(res.status).toBe(422);
  });
});

describe('PATCH /api/v1/menu-items/:id', () => {
  it('requires fnb:manage_menu', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
    const res = await request(createApp())
      .patch('/api/v1/menu-items/menu_1')
      .set('Cookie', authCookie())
      .send({ isAvailable: false });
    expect(res.status).toBe(403);
  });

  it('returns 404 for an unknown item', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESTAURANT_MANAGER'));
    mockPrisma.menuItem.findFirst.mockResolvedValue(null);

    const res = await request(createApp())
      .patch('/api/v1/menu-items/does_not_exist')
      .set('Cookie', authCookie())
      .send({ isAvailable: false });
    expect(res.status).toBe(404);
  });

  it('toggles availability', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESTAURANT_MANAGER'));
    mockPrisma.menuItem.findFirst.mockResolvedValue(fakeMenuItem());
    mockPrisma.menuItem.update.mockResolvedValue(fakeMenuItem({ isAvailable: false }));

    const res = await request(createApp())
      .patch('/api/v1/menu-items/menu_1')
      .set('Cookie', authCookie())
      .send({ isAvailable: false });

    expect(res.status).toBe(200);
    expect(res.body.menuItem.isAvailable).toBe(false);
  });
});
