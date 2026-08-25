import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPrisma = {
  user: { findFirst: vi.fn() },
  amenityItem: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
  amenityRequest: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    aggregate: vi.fn(),
    count: vi.fn(),
  },
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

function fakeAmenityRequest(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'request_1',
    referenceNo: 'AR-260824-0001',
    amenityItemId: 'amenity_1',
    bookingId: null,
    unitId: null,
    qty: 1,
    status: 'REQUESTED',
    requestedById: 'user_1',
    approvedById: null,
    issuedById: null,
    issuedAt: null,
    dueBackAt: null,
    returnedById: null,
    returnedAt: null,
    conditionOnReturn: null,
    notes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    amenityItem: fakeAmenityItem(),
    unit: null,
    requestedBy: { id: 'user_1', fullName: 'Admin Staff (Demo)' },
    approvedBy: null,
    issuedBy: null,
    returnedBy: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.auditLog.findFirst.mockResolvedValue(null);
  mockPrisma.auditLog.count.mockResolvedValue(0);
  mockPrisma.auditLog.findMany.mockResolvedValue([]);
  mockPrisma.referenceSequence.upsert.mockResolvedValue({ scope: 'AR-260824', seq: 1 });
  mockPrisma.amenityRequest.aggregate.mockResolvedValue({ _sum: { qty: null } });
  mockRealtimeEmit.mockResolvedValue(undefined);
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

// Client decision, 2026-08-25 (Option B): a real AmenityItem.delete() is
// now safe once nothing still depends on the live row — see
// deleteAmenityItem's two guards (still active; requests still mid-flow).
describe('DELETE /api/v1/amenity-items/:id', () => {
  it('requires amenity:manage', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
    const res = await request(createApp()).delete('/api/v1/amenity-items/amenity_1').set('Cookie', authCookie());
    expect(res.status).toBe(403);
    expect(mockPrisma.amenityItem.delete).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown item', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.amenityItem.findFirst.mockResolvedValue(null);
    const res = await request(createApp()).delete('/api/v1/amenity-items/does_not_exist').set('Cookie', authCookie());
    expect(res.status).toBe(404);
  });

  it('refuses to delete a still-active item', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.amenityItem.findFirst.mockResolvedValue(fakeAmenityItem({ isActive: true }));
    const res = await request(createApp()).delete('/api/v1/amenity-items/amenity_1').set('Cookie', authCookie());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ITEM_STILL_ACTIVE');
    expect(mockPrisma.amenityItem.delete).not.toHaveBeenCalled();
  });

  it('refuses to delete an inactive item that still has requests in progress', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.amenityItem.findFirst.mockResolvedValue(fakeAmenityItem({ isActive: false }));
    mockPrisma.amenityRequest.count.mockResolvedValue(1);
    const res = await request(createApp()).delete('/api/v1/amenity-items/amenity_1').set('Cookie', authCookie());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ITEM_HAS_ACTIVE_REQUESTS');
    expect(mockPrisma.amenityItem.delete).not.toHaveBeenCalled();
    expect(mockPrisma.amenityRequest.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          amenityItemId: 'amenity_1',
          status: { in: ['REQUESTED', 'APPROVED', 'ISSUED', 'OVERDUE'] },
        }),
      }),
    );
  });

  it('deletes an inactive item with no requests in progress', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.amenityItem.findFirst.mockResolvedValue(fakeAmenityItem({ isActive: false }));
    mockPrisma.amenityRequest.count.mockResolvedValue(0);
    mockPrisma.amenityItem.delete.mockResolvedValue(fakeAmenityItem({ isActive: false }));
    const res = await request(createApp()).delete('/api/v1/amenity-items/amenity_1').set('Cookie', authCookie());
    expect(res.status).toBe(204);
    expect(mockPrisma.amenityItem.delete).toHaveBeenCalledWith({ where: { id: 'amenity_1' } });
  });
});

describe('POST /api/v1/amenity-requests', () => {
  it('requires amenity:request', async () => {
    // HOUSEKEEPING_STAFF holds amenity:approve/issue/return but not
    // amenity:request (see rolePermissions.ts) — can process requests but
    // not originate one.
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('HOUSEKEEPING_STAFF'));
    const res = await request(createApp())
      .post('/api/v1/amenity-requests')
      .set('Cookie', authCookie())
      .send({ amenityItemId: 'amenity_1', qty: 1 });
    expect(res.status).toBe(403);
  });

  it('rejects an unknown or inactive amenity item', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
    mockPrisma.amenityItem.findFirst.mockResolvedValue(null);
    const res = await request(createApp())
      .post('/api/v1/amenity-requests')
      .set('Cookie', authCookie())
      .send({ amenityItemId: 'does_not_exist', qty: 1 });
    expect(res.status).toBe(422);
  });

  it('creates a request and broadcasts amenity.request.changed', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
    mockPrisma.amenityItem.findFirst.mockResolvedValue(fakeAmenityItem());
    mockPrisma.amenityRequest.create.mockResolvedValue(fakeAmenityRequest());

    const res = await request(createApp())
      .post('/api/v1/amenity-requests')
      .set('Cookie', authCookie())
      .send({ amenityItemId: 'amenity_1', qty: 1 });

    expect(res.status).toBe(201);
    expect(res.body.amenityRequest.referenceNo).toBe('AR-260824-0001');
    expect(res.body.amenityRequest.amenityItem.depositAmount).toBe(500);
    expect(mockRealtimeEmit).toHaveBeenCalledWith(
      'property',
      'amenity.request.changed',
      expect.objectContaining({ entityId: 'request_1' }),
    );
  });
});

describe('GET /api/v1/amenity-requests and /:id', () => {
  it('requires amenity:read', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('MAINTENANCE_STAFF'));
    const res = await request(createApp()).get('/api/v1/amenity-requests').set('Cookie', authCookie());
    expect(res.status).toBe(403);
  });

  it('lists requests', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
    mockPrisma.amenityRequest.findMany.mockResolvedValue([fakeAmenityRequest()]);
    const res = await request(createApp()).get('/api/v1/amenity-requests').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.amenityRequests).toHaveLength(1);
  });

  it('returns 404 for an unknown request', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
    mockPrisma.amenityRequest.findFirst.mockResolvedValue(null);
    const res = await request(createApp()).get('/api/v1/amenity-requests/does_not_exist').set('Cookie', authCookie());
    expect(res.status).toBe(404);
  });

  // Client decision, 2026-08-25 (Option B): itemName prefers the
  // snapshot taken at request time, falls back to the live AmenityItem
  // relation for a pre-snapshot historical row, and finally to a
  // placeholder once the item is genuinely deleted (amenityItem: null).
  it('itemName prefers the snapshot, then the live relation, then a placeholder', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
    mockPrisma.amenityRequest.findMany.mockResolvedValue([
      fakeAmenityRequest({ amenityItemName: 'PS4 (snapshot)', amenityItem: fakeAmenityItem({ name: 'PS4 (live)' }) }),
      fakeAmenityRequest({ id: 'request_2', amenityItemName: null, amenityItem: fakeAmenityItem({ name: 'PS5 (live)' }) }),
      fakeAmenityRequest({ id: 'request_3', amenityItemName: null, amenityItem: null }),
    ]);
    const res = await request(createApp()).get('/api/v1/amenity-requests').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    const [snap, legacy, gone] = res.body.amenityRequests;
    expect(snap.itemName).toBe('PS4 (snapshot)');
    expect(legacy.itemName).toBe('PS5 (live)');
    expect(gone.itemName).toBe('(deleted item)');
    expect(gone.amenityItem).toBeNull();
  });
});

describe('POST /api/v1/amenity-requests/:id/status', () => {
  it('rejects an invalid transition', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.amenityRequest.findFirst.mockResolvedValue(fakeAmenityRequest({ status: 'REQUESTED' }));
    const res = await request(createApp())
      .post('/api/v1/amenity-requests/request_1/status')
      .set('Cookie', authCookie())
      .send({ toStatus: 'ISSUED' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVALID_TRANSITION');
  });

  it('rejects APPROVED -> ISSUED for a caller with no amenity:* permission at all', async () => {
    // Every seeded role holding amenity:approve also holds amenity:issue
    // in this codebase's role matrix, so there's no "can approve but not
    // issue" role to test the split with — MAINTENANCE_STAFF (no
    // amenity:* key at all) still proves the route checks the specific
    // transition's permission (amenity:issue), not just "logged in."
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('MAINTENANCE_STAFF'));
    mockPrisma.amenityRequest.findFirst.mockResolvedValue(fakeAmenityRequest({ status: 'APPROVED' }));
    const res = await request(createApp())
      .post('/api/v1/amenity-requests/request_1/status')
      .set('Cookie', authCookie())
      .send({ toStatus: 'ISSUED', dueBackAt: new Date().toISOString() });
    expect(res.status).toBe(403);
  });

  it('approves a REQUESTED request', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.amenityRequest.findFirst.mockResolvedValue(fakeAmenityRequest({ status: 'REQUESTED' }));
    mockPrisma.amenityRequest.update.mockResolvedValue(fakeAmenityRequest({ status: 'APPROVED', approvedById: 'user_1' }));

    const res = await request(createApp())
      .post('/api/v1/amenity-requests/request_1/status')
      .set('Cookie', authCookie())
      .send({ toStatus: 'APPROVED' });

    expect(res.status).toBe(200);
    expect(res.body.amenityRequest.status).toBe('APPROVED');
    expect(mockPrisma.amenityRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'APPROVED', approvedById: 'user_1' }) }),
    );
  });

  // Spec §7.4: "Items with requiresDeposit cannot move to ISSUED without
  // a recorded deposit amount" — enforced here as a plain confirmation
  // gate, per the monitoring-not-transactions scope decision.
  it('refuses to issue a deposit-requiring item without depositCollected confirmed', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.amenityRequest.findFirst.mockResolvedValue(
      fakeAmenityRequest({ status: 'APPROVED', amenityItem: fakeAmenityItem({ requiresDeposit: true }) }),
    );

    const res = await request(createApp())
      .post('/api/v1/amenity-requests/request_1/status')
      .set('Cookie', authCookie())
      .send({ toStatus: 'ISSUED', dueBackAt: new Date().toISOString() });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('DEPOSIT_REQUIRED');
    expect(mockPrisma.amenityRequest.update).not.toHaveBeenCalled();
  });

  it('requires dueBackAt when issuing', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.amenityRequest.findFirst.mockResolvedValue(
      fakeAmenityRequest({ status: 'APPROVED', amenityItem: fakeAmenityItem({ requiresDeposit: false }) }),
    );

    const res = await request(createApp())
      .post('/api/v1/amenity-requests/request_1/status')
      .set('Cookie', authCookie())
      .send({ toStatus: 'ISSUED' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('issues a deposit-requiring item once depositCollected is confirmed', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.amenityRequest.findFirst.mockResolvedValue(
      fakeAmenityRequest({ status: 'APPROVED', amenityItem: fakeAmenityItem({ requiresDeposit: true }) }),
    );
    mockPrisma.amenityRequest.update.mockResolvedValue(fakeAmenityRequest({ status: 'ISSUED' }));

    const dueBackAt = new Date().toISOString();
    const res = await request(createApp())
      .post('/api/v1/amenity-requests/request_1/status')
      .set('Cookie', authCookie())
      .send({ toStatus: 'ISSUED', depositCollected: true, dueBackAt });

    expect(res.status).toBe(200);
    expect(mockPrisma.amenityRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'ISSUED', issuedById: 'user_1', dueBackAt: new Date(dueBackAt) }),
      }),
    );
  });

  // Real bug found live-testing, 2026-08-25: an item (totalQty: 1) could
  // be issued three separate times with no warning at all — the system
  // had no way of knowing it was actually out of stock.
  describe('stock check on ISSUED', () => {
    it('refuses to issue when every unit is already out (ISSUED elsewhere)', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
      mockPrisma.amenityRequest.findFirst.mockResolvedValue(
        fakeAmenityRequest({ status: 'APPROVED', qty: 1, amenityItem: fakeAmenityItem({ totalQty: 1, requiresDeposit: false }) }),
      );
      // One unit already checked out elsewhere — none left for this request.
      mockPrisma.amenityRequest.aggregate.mockResolvedValue({ _sum: { qty: 1 } });

      const res = await request(createApp())
        .post('/api/v1/amenity-requests/request_1/status')
        .set('Cookie', authCookie())
        .send({ toStatus: 'ISSUED', dueBackAt: new Date().toISOString() });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
      expect(res.body.error.details).toMatchObject({ available: 0, totalQty: 1, requestedQty: 1 });
      expect(mockPrisma.amenityRequest.update).not.toHaveBeenCalled();
    });

    // OVERDUE must count as still-out, same as ISSUED — otherwise stock
    // would appear to "reappear" the moment a borrower fails to return
    // on time, which is backwards.
    it('counts OVERDUE requests as still outstanding, not just ISSUED', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
      mockPrisma.amenityRequest.findFirst.mockResolvedValue(
        fakeAmenityRequest({ status: 'APPROVED', qty: 1, amenityItem: fakeAmenityItem({ totalQty: 1, requiresDeposit: false }) }),
      );
      mockPrisma.amenityRequest.aggregate.mockResolvedValue({ _sum: { qty: 1 } });

      const res = await request(createApp())
        .post('/api/v1/amenity-requests/request_1/status')
        .set('Cookie', authCookie())
        .send({ toStatus: 'ISSUED', dueBackAt: new Date().toISOString() });

      expect(res.status).toBe(409);
      expect(mockPrisma.amenityRequest.aggregate).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ status: { in: ['ISSUED', 'OVERDUE'] } }) }),
      );
    });

    it('allows issuing when enough stock remains', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
      mockPrisma.amenityRequest.findFirst.mockResolvedValue(
        fakeAmenityRequest({ status: 'APPROVED', qty: 1, amenityItem: fakeAmenityItem({ totalQty: 2, requiresDeposit: false }) }),
      );
      mockPrisma.amenityRequest.aggregate.mockResolvedValue({ _sum: { qty: 1 } });
      mockPrisma.amenityRequest.update.mockResolvedValue(fakeAmenityRequest({ status: 'ISSUED' }));

      const res = await request(createApp())
        .post('/api/v1/amenity-requests/request_1/status')
        .set('Cookie', authCookie())
        .send({ toStatus: 'ISSUED', dueBackAt: new Date().toISOString() });

      expect(res.status).toBe(200);
    });

    it('refuses when this request alone would exceed remaining stock (qty > 1)', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
      mockPrisma.amenityRequest.findFirst.mockResolvedValue(
        fakeAmenityRequest({ status: 'APPROVED', qty: 3, amenityItem: fakeAmenityItem({ totalQty: 3, requiresDeposit: false }) }),
      );
      mockPrisma.amenityRequest.aggregate.mockResolvedValue({ _sum: { qty: 1 } });

      const res = await request(createApp())
        .post('/api/v1/amenity-requests/request_1/status')
        .set('Cookie', authCookie())
        .send({ toStatus: 'ISSUED', dueBackAt: new Date().toISOString() });

      expect(res.status).toBe(409);
      expect(res.body.error.details).toMatchObject({ available: 2, totalQty: 3, requestedQty: 3 });
    });
  });

  it('returns an ISSUED item, recording who and when', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.amenityRequest.findFirst.mockResolvedValue(fakeAmenityRequest({ status: 'ISSUED' }));
    mockPrisma.amenityRequest.update.mockResolvedValue(fakeAmenityRequest({ status: 'RETURNED' }));

    const res = await request(createApp())
      .post('/api/v1/amenity-requests/request_1/status')
      .set('Cookie', authCookie())
      .send({ toStatus: 'RETURNED', conditionOnReturn: 'Good, no damage' });

    expect(res.status).toBe(200);
    expect(mockPrisma.amenityRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'RETURNED',
          returnedById: 'user_1',
          conditionOnReturn: 'Good, no damage',
        }),
      }),
    );
  });
});

describe('POST /api/v1/jobs/amenity-overdue', () => {
  it('rejects a missing job secret', async () => {
    const res = await request(createApp()).post('/api/v1/jobs/amenity-overdue');
    expect(res.status).toBe(401);
  });

  it('rejects a wrong job secret', async () => {
    const res = await request(createApp()).post('/api/v1/jobs/amenity-overdue').set('x-job-secret', 'wrong');
    expect(res.status).toBe(401);
  });

  it('flips ISSUED requests past dueBackAt to OVERDUE given the correct secret', async () => {
    mockPrisma.amenityRequest.updateMany.mockResolvedValue({ count: 3 });
    const res = await request(createApp())
      .post('/api/v1/jobs/amenity-overdue')
      .set('x-job-secret', process.env.JOB_SECRET as string);
    expect(res.status).toBe(200);
    expect(res.body.flippedCount).toBe(3);
    expect(mockPrisma.amenityRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'ISSUED', deletedAt: null }),
        data: { status: 'OVERDUE' },
      }),
    );
  });
});
