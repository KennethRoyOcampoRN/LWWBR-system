import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPrisma = {
  user: { findFirst: vi.fn() },
  unit: { findFirst: vi.fn() },
  menuItem: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  fnbOrder: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  setting: { findUnique: vi.fn() },
  referenceSequence: { upsert: vi.fn() },
  auditLog: { create: vi.fn(), count: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
};

vi.mock('../../../src/lib/prisma.js', () => ({ prisma: mockPrisma }));

const mockRealtimeEmit = vi.fn();
vi.mock('../../../src/adapters/realtime/index.js', () => ({
  getRealtimeAdapter: () => ({ emit: mockRealtimeEmit }),
}));

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

function fakeFnbOrder(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'order_1',
    referenceNo: 'FB-260824-0001',
    unitId: null,
    bookingId: null,
    guestName: null,
    type: 'DINE_IN',
    scheduledFor: null,
    settlement: 'PAY_NOW',
    status: 'RECEIVED',
    version: 0,
    subtotal: 250,
    notes: null,
    createdById: 'user_1',
    acknowledgedById: null,
    acknowledgedAt: null,
    preparingAt: null,
    readyAt: null,
    servedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    unit: null,
    createdBy: { id: 'user_1', fullName: 'Restaurant Manager (Demo)' },
    lines: [{ id: 'line_1', fnbOrderId: 'order_1', menuItemId: 'menu_1', qty: 1, unitPrice: 250, notes: null, menuItem: { id: 'menu_1', name: 'Sisig' } }],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.auditLog.findFirst.mockResolvedValue(null);
  mockPrisma.auditLog.count.mockResolvedValue(0);
  mockPrisma.auditLog.findMany.mockResolvedValue([]);
  mockPrisma.referenceSequence.upsert.mockResolvedValue({ scope: 'FB-260824', seq: 1 });
  mockPrisma.setting.findUnique.mockResolvedValue(null);
  mockRealtimeEmit.mockResolvedValue(undefined);
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

describe('POST /api/v1/fnb-orders', () => {
  it('requires fnb:create', async () => {
    // HOUSEKEEPING_STAFF holds no fnb:* key at all.
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('HOUSEKEEPING_STAFF'));
    const res = await request(createApp())
      .post('/api/v1/fnb-orders')
      .set('Cookie', authCookie())
      .send({ type: 'DINE_IN', settlement: 'PAY_NOW', lines: [{ menuItemId: 'menu_1', qty: 1 }] });
    expect(res.status).toBe(403);
  });

  it('rejects an unknown or unavailable menu item', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESTAURANT_MANAGER'));
    mockPrisma.menuItem.findMany.mockResolvedValue([]);
    const res = await request(createApp())
      .post('/api/v1/fnb-orders')
      .set('Cookie', authCookie())
      .send({ type: 'DINE_IN', settlement: 'PAY_NOW', lines: [{ menuItemId: 'menu_1', qty: 1 }] });
    expect(res.status).toBe(422);
  });

  it('requires scheduledFor for an ADVANCE_ORDER', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESTAURANT_MANAGER'));
    const res = await request(createApp())
      .post('/api/v1/fnb-orders')
      .set('Cookie', authCookie())
      .send({ type: 'ADVANCE_ORDER', settlement: 'PAY_NOW', lines: [{ menuItemId: 'menu_1', qty: 1 }] });
    expect(res.status).toBe(422);
  });

  // Spec §7.6's original NO_ACTIVE_FOLIO gate doesn't survive with no
  // folio to validate against, but the client asked to keep a lighter
  // version: CHARGE_TO_ROOM still requires a real, currently-occupied
  // unit — cheap and still useful monitoring information, no balance
  // math behind it.
  it('rejects CHARGE_TO_ROOM with no unitId', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESTAURANT_MANAGER'));
    const res = await request(createApp())
      .post('/api/v1/fnb-orders')
      .set('Cookie', authCookie())
      .send({ type: 'DINE_IN', settlement: 'CHARGE_TO_ROOM', lines: [{ menuItemId: 'menu_1', qty: 1 }] });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects CHARGE_TO_ROOM against a unit that is not OCCUPIED', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESTAURANT_MANAGER'));
    mockPrisma.unit.findFirst.mockResolvedValue({ id: 'unit_1', status: 'VACANT_DIRTY' });
    const res = await request(createApp())
      .post('/api/v1/fnb-orders')
      .set('Cookie', authCookie())
      .send({ type: 'ROOM_SERVICE', settlement: 'CHARGE_TO_ROOM', unitId: 'unit_1', lines: [{ menuItemId: 'menu_1', qty: 1 }] });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('UNIT_NOT_OCCUPIED');
  });

  it('creates an order, snapshotting menu prices and computing the subtotal', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESTAURANT_MANAGER'));
    mockPrisma.unit.findFirst.mockResolvedValue({ id: 'unit_1', status: 'OCCUPIED' });
    mockPrisma.menuItem.findMany.mockResolvedValue([
      fakeMenuItem({ id: 'menu_1', price: 250 }),
      fakeMenuItem({ id: 'menu_2', name: 'Halo-Halo', price: 120 }),
    ]);
    mockPrisma.fnbOrder.create.mockResolvedValue(
      fakeFnbOrder({
        settlement: 'CHARGE_TO_ROOM',
        unitId: 'unit_1',
        subtotal: 620,
        lines: [
          { id: 'line_1', menuItemId: 'menu_1', qty: 2, unitPrice: 250, notes: null, menuItem: { id: 'menu_1', name: 'Sisig' } },
          { id: 'line_2', menuItemId: 'menu_2', qty: 1, unitPrice: 120, notes: null, menuItem: { id: 'menu_2', name: 'Halo-Halo' } },
        ],
      }),
    );

    const res = await request(createApp())
      .post('/api/v1/fnb-orders')
      .set('Cookie', authCookie())
      .send({
        type: 'ROOM_SERVICE',
        settlement: 'CHARGE_TO_ROOM',
        unitId: 'unit_1',
        lines: [
          { menuItemId: 'menu_1', qty: 2 },
          { menuItemId: 'menu_2', qty: 1 },
        ],
      });

    expect(res.status).toBe(201);
    expect(mockPrisma.fnbOrder.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          subtotal: 620,
          lines: { create: [{ menuItemId: 'menu_1', qty: 2, unitPrice: 250, notes: undefined }, { menuItemId: 'menu_2', qty: 1, unitPrice: 120, notes: undefined }] },
        }),
      }),
    );
    expect(res.body.fnbOrder.subtotal).toBe(620);
    expect(res.body.fnbOrder.lines[0].unitPrice).toBe(250);
    expect(mockRealtimeEmit).toHaveBeenCalledWith('property', 'fnb.order.created', expect.objectContaining({ entityId: 'order_1' }));
  });
});

describe('GET /api/v1/fnb-orders', () => {
  it('requires fnb:read', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('HOUSEKEEPING_STAFF'));
    const res = await request(createApp()).get('/api/v1/fnb-orders').set('Cookie', authCookie());
    expect(res.status).toBe(403);
  });

  it('lists orders', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
    mockPrisma.fnbOrder.findMany.mockResolvedValue([fakeFnbOrder()]);
    const res = await request(createApp()).get('/api/v1/fnb-orders').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.fnbOrders).toHaveLength(1);
  });

  // The board query hides RECEIVED/PREPARING/READY orders of type
  // ADVANCE_ORDER until the lead-time window opens (spec §7.3) —
  // asserted against the actual where-clause built, since a mocked
  // findMany can't otherwise exercise it.
  it('boardOnly applies the active-status and advance-order lead-time filter', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
    mockPrisma.fnbOrder.findMany.mockResolvedValue([]);
    mockPrisma.setting.findUnique.mockResolvedValue({ key: 'fnb.advanceOrderLeadMinutes', value: 90 });

    const res = await request(createApp()).get('/api/v1/fnb-orders?boardOnly=true').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(mockPrisma.fnbOrder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ['RECEIVED', 'PREPARING', 'READY'] },
          OR: [{ type: { not: 'ADVANCE_ORDER' } }, { scheduledFor: { lte: expect.any(Date) } }],
        }),
      }),
    );
  });
});

describe('POST /api/v1/fnb-orders/:id/status', () => {
  it('rejects an invalid transition', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESTAURANT_STAFF'));
    mockPrisma.fnbOrder.findFirst.mockResolvedValue(fakeFnbOrder({ status: 'RECEIVED' }));
    const res = await request(createApp())
      .post('/api/v1/fnb-orders/order_1/status')
      .set('Cookie', authCookie())
      .send({ toStatus: 'SERVED' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVALID_TRANSITION');
  });

  // RESORT_MANAGER holds fnb:read/fnb:create but not fnb:update_status
  // (see rolePermissions.ts's own header comment: those roles see the
  // kitchen board but don't drag tickets through it — that's Restaurant
  // Manager/Staff's job).
  it('rejects a status change for a caller without fnb:update_status', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.fnbOrder.findFirst.mockResolvedValue(fakeFnbOrder({ status: 'RECEIVED' }));
    const res = await request(createApp())
      .post('/api/v1/fnb-orders/order_1/status')
      .set('Cookie', authCookie())
      .send({ toStatus: 'PREPARING' });
    expect(res.status).toBe(403);
  });

  it('moves RECEIVED -> PREPARING, recording who acknowledged it', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESTAURANT_STAFF'));
    mockPrisma.fnbOrder.findFirst.mockResolvedValue(fakeFnbOrder({ status: 'RECEIVED' }));
    mockPrisma.fnbOrder.update.mockResolvedValue(fakeFnbOrder({ status: 'PREPARING' }));

    const res = await request(createApp())
      .post('/api/v1/fnb-orders/order_1/status')
      .set('Cookie', authCookie())
      .send({ toStatus: 'PREPARING' });

    expect(res.status).toBe(200);
    expect(mockPrisma.fnbOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'PREPARING', acknowledgedById: 'user_1' }),
      }),
    );
    expect(mockRealtimeEmit).toHaveBeenCalledWith(
      'property',
      'fnb.order.status.changed',
      expect.objectContaining({ entityId: 'order_1' }),
    );
  });

  // Client decision, 2026-08-25: cancelling an order must require and
  // record a reason, same as forceUnitStatus's mandatory note for a
  // forced status correction.
  it('rejects cancelling without a cancelReason', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESTAURANT_STAFF'));
    mockPrisma.fnbOrder.findFirst.mockResolvedValue(fakeFnbOrder({ status: 'RECEIVED' }));
    const res = await request(createApp())
      .post('/api/v1/fnb-orders/order_1/status')
      .set('Cookie', authCookie())
      .send({ toStatus: 'CANCELLED' });
    expect(res.status).toBe(422);
    expect(mockPrisma.fnbOrder.update).not.toHaveBeenCalled();
  });

  it('cancels an order with a reason, recording who cancelled it and why', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESTAURANT_STAFF'));
    mockPrisma.fnbOrder.findFirst.mockResolvedValue(fakeFnbOrder({ status: 'RECEIVED' }));
    mockPrisma.fnbOrder.update.mockResolvedValue(
      fakeFnbOrder({ status: 'CANCELLED', cancelledById: 'user_1', cancelReason: 'Guest changed their mind' }),
    );

    const res = await request(createApp())
      .post('/api/v1/fnb-orders/order_1/status')
      .set('Cookie', authCookie())
      .send({ toStatus: 'CANCELLED', cancelReason: 'Guest changed their mind' });

    expect(res.status).toBe(200);
    expect(mockPrisma.fnbOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'CANCELLED',
          cancelledById: 'user_1',
          cancelReason: 'Guest changed their mind',
        }),
      }),
    );
    expect(res.body.fnbOrder.cancelReason).toBe('Guest changed their mind');
  });
});
