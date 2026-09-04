import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPrisma = {
  user: { findFirst: vi.fn() },
  stockItem: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  stockMovement: { findMany: vi.fn(), create: vi.fn() },
  auditLog: { create: vi.fn(), count: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
  $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
};

vi.mock('../../../src/lib/prisma.js', () => ({ prisma: mockPrisma }));

const { createApp } = await import('../../../src/app.js');
const { signAccessToken } = await import('../../../src/modules/auth/tokens.js');
const { listLowStockItems } = await import('../../../src/modules/stock/service.js');

function userWithRole(roleKey: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'user_1',
    employeeCode: 'LWW-030',
    fullName: 'Stock Manager (Demo)',
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

function fakeStockItem(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'stock_1',
    name: 'Toilet Paper (12-roll pack)',
    category: 'CLEANING',
    unitOfMeasure: 'pack',
    currentQty: '20.00',
    reorderLevel: '10.00',
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

function fakeStockMovement(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'movement_1',
    stockItemId: 'stock_1',
    delta: '5.00',
    reason: 'RECEIVE',
    workOrderId: null,
    actorId: 'user_1',
    note: null,
    createdAt: new Date(),
    actor: { id: 'user_1', fullName: 'Stock Manager (Demo)' },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.auditLog.findFirst.mockResolvedValue(null);
  mockPrisma.auditLog.count.mockResolvedValue(0);
  mockPrisma.auditLog.findMany.mockResolvedValue([]);
  mockPrisma.$transaction.mockImplementation(async (ops: Promise<unknown>[]) => Promise.all(ops));
});

describe('POST /api/v1/stock-items', () => {
  it('allows STOCK_MANAGER to create a stock item', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('STOCK_MANAGER'));
    mockPrisma.stockItem.create.mockResolvedValue(fakeStockItem());

    const res = await request(createApp())
      .post('/api/v1/stock-items')
      .set('Cookie', authCookie())
      .send({ name: 'Toilet Paper (12-roll pack)', category: 'CLEANING', unitOfMeasure: 'pack', reorderLevel: 10, initialQty: 20 });

    expect(res.status).toBe(201);
    expect(res.body.stockItem.name).toBe('Toilet Paper (12-roll pack)');
    expect(res.body.stockItem.currentQty).toBe(20);
    expect(typeof res.body.stockItem.currentQty).toBe('number');
  });

  it('refuses a role with no stock:* access at all (RESORT_STAFF)', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_STAFF'));
    const res = await request(createApp())
      .post('/api/v1/stock-items')
      .set('Cookie', authCookie())
      .send({ name: 'x', category: 'CLEANING', unitOfMeasure: 'pack', reorderLevel: 10 });
    expect(res.status).toBe(403);
  });

  // Not baked into SYSTEM_ADMIN's default grants — see rolePermissions.ts's
  // STOCK_MANAGER-block comment for the reasoning.
  it('refuses SYSTEM_ADMIN — stock:* is not baked into its default grants', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('SYSTEM_ADMIN'));
    const res = await request(createApp())
      .post('/api/v1/stock-items')
      .set('Cookie', authCookie())
      .send({ name: 'x', category: 'CLEANING', unitOfMeasure: 'pack', reorderLevel: 10 });
    expect(res.status).toBe(403);
  });

  it('defaults initialQty to 0 when omitted', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('STOCK_MANAGER'));
    mockPrisma.stockItem.create.mockResolvedValue(fakeStockItem({ currentQty: '0' }));

    const res = await request(createApp())
      .post('/api/v1/stock-items')
      .set('Cookie', authCookie())
      .send({ name: 'x', category: 'OTHER', unitOfMeasure: 'pcs', reorderLevel: 5 });

    expect(res.status).toBe(201);
    expect(mockPrisma.stockItem.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ currentQty: 0 }) }),
    );
  });
});

describe('GET /api/v1/stock-items', () => {
  it('allows STOCK_MANAGER to list items', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('STOCK_MANAGER'));
    mockPrisma.stockItem.findMany.mockResolvedValue([fakeStockItem()]);
    const res = await request(createApp()).get('/api/v1/stock-items').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.stockItems).toHaveLength(1);
  });

  it('refuses a role with no stock:* access at all', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_STAFF'));
    const res = await request(createApp()).get('/api/v1/stock-items').set('Cookie', authCookie());
    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/v1/stock-items/:id', () => {
  it('allows STOCK_MANAGER to edit the catalog (name/category/UOM/reorderLevel/isActive)', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('STOCK_MANAGER'));
    mockPrisma.stockItem.findFirst.mockResolvedValue(fakeStockItem());
    mockPrisma.stockItem.update.mockResolvedValue(fakeStockItem({ reorderLevel: '15.00' }));

    const res = await request(createApp())
      .patch('/api/v1/stock-items/stock_1')
      .set('Cookie', authCookie())
      .send({ reorderLevel: 15 });

    expect(res.status).toBe(200);
    expect(res.body.stockItem.reorderLevel).toBe(15);
  });

  // currentQty is never editable through this route — see
  // stock/service.ts's updateStockItem comment for why (only movements
  // may change it, so the audit trail can't be bypassed). The schema's
  // own .strict() rejects an unknown field before the service is reached.
  it('rejects an attempt to set currentQty directly', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('STOCK_MANAGER'));
    const res = await request(createApp())
      .patch('/api/v1/stock-items/stock_1')
      .set('Cookie', authCookie())
      .send({ currentQty: 999 });
    expect(res.status).toBe(422);
    expect(mockPrisma.stockItem.update).not.toHaveBeenCalled();
  });

  it('404s for an item that does not exist', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('STOCK_MANAGER'));
    mockPrisma.stockItem.findFirst.mockResolvedValue(null);
    const res = await request(createApp())
      .patch('/api/v1/stock-items/missing')
      .set('Cookie', authCookie())
      .send({ reorderLevel: 5 });
    expect(res.status).toBe(404);
  });

  it('refuses a role with no stock:* access at all', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_STAFF'));
    const res = await request(createApp())
      .patch('/api/v1/stock-items/stock_1')
      .set('Cookie', authCookie())
      .send({ reorderLevel: 5 });
    expect(res.status).toBe(403);
  });
});

describe('POST /api/v1/stock-items/:id/movements', () => {
  it('logs a RECEIVE and increments currentQty', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('STOCK_MANAGER'));
    mockPrisma.stockItem.findFirst.mockResolvedValue(fakeStockItem({ currentQty: '20.00' }));
    mockPrisma.stockMovement.create.mockResolvedValue(fakeStockMovement({ delta: '10.00', reason: 'RECEIVE' }));
    mockPrisma.stockItem.update.mockResolvedValue(fakeStockItem({ currentQty: '30.00' }));

    const res = await request(createApp())
      .post('/api/v1/stock-items/stock_1/movements')
      .set('Cookie', authCookie())
      .send({ reason: 'RECEIVE', quantity: 10 });

    expect(res.status).toBe(201);
    expect(res.body.stockMovement.delta).toBe(10);
    expect(mockPrisma.stockMovement.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ delta: 10, reason: 'RECEIVE' }) }),
    );
    expect(mockPrisma.stockItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'stock_1' }, data: { currentQty: { increment: 10 } } }),
    );
  });

  it('logs a CONSUME as a negative delta', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('STOCK_MANAGER'));
    mockPrisma.stockItem.findFirst.mockResolvedValue(fakeStockItem({ currentQty: '20.00' }));
    mockPrisma.stockMovement.create.mockResolvedValue(fakeStockMovement({ delta: '-5.00', reason: 'CONSUME' }));
    mockPrisma.stockItem.update.mockResolvedValue(fakeStockItem({ currentQty: '15.00' }));

    const res = await request(createApp())
      .post('/api/v1/stock-items/stock_1/movements')
      .set('Cookie', authCookie())
      .send({ reason: 'CONSUME', quantity: 5 });

    expect(res.status).toBe(201);
    expect(res.body.stockMovement.delta).toBe(-5);
    expect(mockPrisma.stockItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { currentQty: { increment: -5 } } }),
    );
  });

  it('rejects a CONSUME that would take currentQty negative', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('STOCK_MANAGER'));
    mockPrisma.stockItem.findFirst.mockResolvedValue(fakeStockItem({ currentQty: '3.00' }));

    const res = await request(createApp())
      .post('/api/v1/stock-items/stock_1/movements')
      .set('Cookie', authCookie())
      .send({ reason: 'CONSUME', quantity: 5 });

    expect(res.status).toBe(422);
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
  });

  it('rejects a negative quantity for RECEIVE — use ADJUST for a signed correction', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('STOCK_MANAGER'));
    mockPrisma.stockItem.findFirst.mockResolvedValue(fakeStockItem());

    const res = await request(createApp())
      .post('/api/v1/stock-items/stock_1/movements')
      .set('Cookie', authCookie())
      .send({ reason: 'RECEIVE', quantity: -5 });

    expect(res.status).toBe(422);
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
  });

  // ADJUST takes the signed correction directly — can go either
  // direction, unlike RECEIVE/CONSUME's fixed sign.
  it('logs an ADJUST with a signed delta taken directly from the input, positive direction', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('STOCK_MANAGER'));
    mockPrisma.stockItem.findFirst.mockResolvedValue(fakeStockItem({ currentQty: '20.00' }));
    mockPrisma.stockMovement.create.mockResolvedValue(fakeStockMovement({ delta: '3.00', reason: 'ADJUST' }));
    mockPrisma.stockItem.update.mockResolvedValue(fakeStockItem({ currentQty: '23.00' }));

    const res = await request(createApp())
      .post('/api/v1/stock-items/stock_1/movements')
      .set('Cookie', authCookie())
      .send({ reason: 'ADJUST', quantity: 3, note: 'Recount found 3 more than logged' });

    expect(res.status).toBe(201);
    expect(mockPrisma.stockMovement.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ delta: 3, reason: 'ADJUST' }) }),
    );
  });

  it('logs an ADJUST with a signed delta taken directly from the input, negative direction', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('STOCK_MANAGER'));
    mockPrisma.stockItem.findFirst.mockResolvedValue(fakeStockItem({ currentQty: '20.00' }));
    mockPrisma.stockMovement.create.mockResolvedValue(fakeStockMovement({ delta: '-4.00', reason: 'ADJUST' }));
    mockPrisma.stockItem.update.mockResolvedValue(fakeStockItem({ currentQty: '16.00' }));

    const res = await request(createApp())
      .post('/api/v1/stock-items/stock_1/movements')
      .set('Cookie', authCookie())
      .send({ reason: 'ADJUST', quantity: -4 });

    expect(res.status).toBe(201);
    expect(mockPrisma.stockItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { currentQty: { increment: -4 } } }),
    );
  });

  it('rejects a movement against an inactive item', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('STOCK_MANAGER'));
    mockPrisma.stockItem.findFirst.mockResolvedValue(fakeStockItem({ isActive: false }));

    const res = await request(createApp())
      .post('/api/v1/stock-items/stock_1/movements')
      .set('Cookie', authCookie())
      .send({ reason: 'RECEIVE', quantity: 5 });

    expect(res.status).toBe(409);
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
  });

  it('404s for an item that does not exist', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('STOCK_MANAGER'));
    mockPrisma.stockItem.findFirst.mockResolvedValue(null);

    const res = await request(createApp())
      .post('/api/v1/stock-items/missing/movements')
      .set('Cookie', authCookie())
      .send({ reason: 'RECEIVE', quantity: 5 });

    expect(res.status).toBe(404);
  });

  it('refuses a role holding only stock:read — logging a movement needs stock:log_movement', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_STAFF'));
    const res = await request(createApp())
      .post('/api/v1/stock-items/stock_1/movements')
      .set('Cookie', authCookie())
      .send({ reason: 'RECEIVE', quantity: 5 });
    expect(res.status).toBe(403);
    expect(mockPrisma.stockMovement.create).not.toHaveBeenCalled();
  });
});

describe('GET /api/v1/stock-movements', () => {
  it('allows STOCK_MANAGER to view movement history', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('STOCK_MANAGER'));
    mockPrisma.stockMovement.findMany.mockResolvedValue([fakeStockMovement()]);
    const res = await request(createApp()).get('/api/v1/stock-movements').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.stockMovements).toHaveLength(1);
  });

  it('refuses a role with no stock:* access at all', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_STAFF'));
    const res = await request(createApp()).get('/api/v1/stock-movements').set('Cookie', authCookie());
    expect(res.status).toBe(403);
  });
});

// Command Center attention-queue/KPI source (2026-08-31) — this function
// has no HTTP route of its own (called internally from units/service.ts's
// getUnitsDashboard, unconditionally, unlike listPendingRemittances/
// listPendingQuotations; see that module's own doc comment for why).
// This pins the boundary the client specifically asked to be tested: an
// item exactly at, just above, and just below its reorder level, in one
// test asserting exact list membership so an off-by-one regression fails
// loudly rather than just changing a count.
describe('listLowStockItems', () => {
  it('flags only the item strictly below its reorder level — at and above are not low stock', async () => {
    mockPrisma.stockItem.findMany.mockResolvedValue([
      fakeStockItem({ id: 'at_threshold', name: 'At threshold', currentQty: '10.00', reorderLevel: '10.00' }),
      fakeStockItem({ id: 'above_threshold', name: 'Above threshold', currentQty: '11.00', reorderLevel: '10.00' }),
      fakeStockItem({ id: 'below_threshold', name: 'Below threshold', currentQty: '9.00', reorderLevel: '10.00' }),
    ]);

    const result = await listLowStockItems();

    expect(result.map((item) => item.id)).toEqual(['below_threshold']);
    expect(result[0]).toMatchObject({ id: 'below_threshold', currentQty: 9, reorderLevel: 10 });
  });

  it('excludes inactive items even when below their reorder level', async () => {
    mockPrisma.stockItem.findMany.mockResolvedValue([]);
    await listLowStockItems();
    expect(mockPrisma.stockItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { deletedAt: null, isActive: true } }),
    );
  });

  it('returns an empty list when nothing is below its reorder level', async () => {
    mockPrisma.stockItem.findMany.mockResolvedValue([
      fakeStockItem({ currentQty: '20.00', reorderLevel: '10.00' }),
    ]);
    const result = await listLowStockItems();
    expect(result).toEqual([]);
  });
});
