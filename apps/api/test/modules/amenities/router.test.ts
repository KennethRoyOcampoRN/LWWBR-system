import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPrisma = {
  user: { findFirst: vi.fn() },
  amenityItem: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  auditLog: { create: vi.fn(), count: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
};

vi.mock('../../../src/lib/prisma.js', () => ({ prisma: mockPrisma }));

const { createApp } = await import('../../../src/app.js');
const { signAccessToken } = await import('../../../src/modules/auth/tokens.js');

function userWithRole(roleKey: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'user_1',
    employeeCode: 'LWW-013',
    fullName: 'Admin Staff (Demo)',
    email: null,
    department: 'FRONT_OFFICE',
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

function fakeAmenityItem(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'amenity_1',
    name: 'PS4 Console',
    category: 'CONSOLE',
    assetTag: 'PS4-01',
    totalQty: 2,
    condition: 'Good',
    requiresDeposit: true,
    depositAmount: 500,
    isActive: true,
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

describe('GET /api/v1/amenity-items', () => {
  // MAINTENANCE_STAFF holds no amenity:* key at all — per the role
  // matrix (spec §5.4's "amenity request"/"amenity issue" rows), amenity
  // handling sits with front-desk/ops roles (Admin Staff, Cashier, Resort
  // Manager, etc.), not maintenance.
  it('requires amenity:read', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('MAINTENANCE_STAFF'));
    const res = await request(createApp()).get('/api/v1/amenity-items').set('Cookie', authCookie());
    expect(res.status).toBe(403);
  });

  it('lists amenity items with depositAmount as a plain number', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
    mockPrisma.amenityItem.findMany.mockResolvedValue([fakeAmenityItem()]);

    const res = await request(createApp()).get('/api/v1/amenity-items').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.amenityItems).toHaveLength(1);
    expect(res.body.amenityItems[0].depositAmount).toBe(500);
    expect(typeof res.body.amenityItems[0].depositAmount).toBe('number');
  });
});

describe('POST /api/v1/amenity-items', () => {
  // ADMIN_STAFF holds amenity:read (can see the catalogue) but not
  // amenity:manage (can't edit it) — the read/manage split this route
  // pair exists to enforce.
  it('requires amenity:manage, not just amenity:read', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
    const res = await request(createApp())
      .post('/api/v1/amenity-items')
      .set('Cookie', authCookie())
      .send({ name: 'Videoke Unit', category: 'VIDEOKE', totalQty: 1, condition: 'Good' });
    expect(res.status).toBe(403);
  });

  it('creates an amenity item, defaulting requiresDeposit/depositAmount', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.amenityItem.create.mockResolvedValue(
      fakeAmenityItem({ name: 'Board Game — Monopoly', category: 'BOARD_GAME', requiresDeposit: false, depositAmount: 0 }),
    );

    const res = await request(createApp())
      .post('/api/v1/amenity-items')
      .set('Cookie', authCookie())
      .send({ name: 'Board Game — Monopoly', category: 'BOARD_GAME', totalQty: 3, condition: 'Good' });

    expect(res.status).toBe(201);
    expect(mockPrisma.amenityItem.create).toHaveBeenCalledWith({
      data: {
        name: 'Board Game — Monopoly',
        category: 'BOARD_GAME',
        assetTag: undefined,
        totalQty: 3,
        condition: 'Good',
        requiresDeposit: false,
        depositAmount: 0,
      },
    });
    expect(res.body.amenityItem.depositAmount).toBe(0);
  });

  it('rejects an unknown category', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    const res = await request(createApp())
      .post('/api/v1/amenity-items')
      .set('Cookie', authCookie())
      .send({ name: 'Mystery Item', category: 'NOT_A_CATEGORY', totalQty: 1, condition: 'Good' });
    expect(res.status).toBe(422);
  });
});

describe('PATCH /api/v1/amenity-items/:id', () => {
  it('requires amenity:manage', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
    const res = await request(createApp())
      .patch('/api/v1/amenity-items/amenity_1')
      .set('Cookie', authCookie())
      .send({ isActive: false });
    expect(res.status).toBe(403);
  });

  it('returns 404 for an unknown item', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.amenityItem.findFirst.mockResolvedValue(null);

    const res = await request(createApp())
      .patch('/api/v1/amenity-items/does_not_exist')
      .set('Cookie', authCookie())
      .send({ isActive: false });
    expect(res.status).toBe(404);
  });

  it('updates an existing item', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.amenityItem.findFirst.mockResolvedValue(fakeAmenityItem());
    mockPrisma.amenityItem.update.mockResolvedValue(fakeAmenityItem({ condition: 'Needs repair' }));

    const res = await request(createApp())
      .patch('/api/v1/amenity-items/amenity_1')
      .set('Cookie', authCookie())
      .send({ condition: 'Needs repair' });

    expect(res.status).toBe(200);
    expect(res.body.amenityItem.condition).toBe('Needs repair');
  });
});
