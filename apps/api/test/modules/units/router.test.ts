import { TZDate } from '@date-fns/tz';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPrisma = {
  user: { findFirst: vi.fn() },
  unitType: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  unit: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), delete: vi.fn(), count: vi.fn() },
  ratePlanRate: { deleteMany: vi.fn() },
  $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  unitStatusEvent: { findMany: vi.fn(), create: vi.fn(), count: vi.fn() },
  bookingUnit: { count: vi.fn(), findMany: vi.fn() },
  workOrder: { findMany: vi.fn(), count: vi.fn() },
  amenityRequest: { count: vi.fn(), findMany: vi.fn() },
  fnbOrder: { count: vi.fn() },
  inspection: { count: vi.fn() },
  setting: { findUnique: vi.fn() },
  remittanceRequest: { findMany: vi.fn() },
  quotationRequest: { findMany: vi.fn() },
  stockItem: { findMany: vi.fn() },
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
    employeeCode: 'LWW-008',
    fullName: 'POC Housekeeping (Demo)',
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

function fakeUnit(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'unit_1',
    code: '101',
    name: 'Room 101',
    unitTypeId: 'type_1',
    type: 'ROOM',
    capacity: 2,
    floor: '1',
    status: 'CLEANED',
    version: 3,
    notes: null,
    isActive: true,
    sortOrder: 0,
    deletedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.auditLog.findFirst.mockResolvedValue(null);
  mockPrisma.auditLog.count.mockResolvedValue(0);
  mockPrisma.auditLog.findMany.mockResolvedValue([]);
  mockPrisma.workOrder.findMany.mockResolvedValue([]);
  mockPrisma.workOrder.count.mockResolvedValue(0);
  mockPrisma.unitStatusEvent.count.mockResolvedValue(0);
  mockPrisma.fnbOrder.count.mockResolvedValue(0);
  mockPrisma.amenityRequest.findMany.mockResolvedValue([]);
  mockPrisma.setting.findUnique.mockResolvedValue(null);
  mockPrisma.remittanceRequest.findMany.mockResolvedValue([]);
  mockPrisma.quotationRequest.findMany.mockResolvedValue([]);
  mockPrisma.stockItem.findMany.mockResolvedValue([]);
  mockRealtimeEmit.mockResolvedValue(undefined);
});

describe('GET /api/v1/units and /unit-types', () => {
  it('requires unit:read', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESTAURANT_STAFF'));
    const res = await request(createApp()).get('/api/v1/units').set('Cookie', authCookie());
    expect(res.status).toBe(403);
  });

  it('lists units for a caller with unit:read', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('POC_HOUSEKEEPING'));
    mockPrisma.unit.findMany.mockResolvedValue([fakeUnit()]);
    mockPrisma.unitStatusEvent.findMany.mockResolvedValue([]);

    const res = await request(createApp()).get('/api/v1/units').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.units).toHaveLength(1);
    expect(res.body.units[0].status).toBe('CLEANED');
    expect(res.body.units[0].latestNote).toBeNull();
    // Real-world caching gap found live 2026-08-23 while investigating a
    // report of a stale unit status persisting in the UI: every /api/v1
    // response now sets Cache-Control: no-store so a browser can never
    // legitimately serve a cached read of live operational state.
    expect(res.headers['cache-control']).toBe('no-store');
  });

  // Cashier-tab plan (spec.md §13.4, Stage B, 2026-11-05): booking id +
  // guest name on every unit card — previously fetched only inside the
  // drawer, per unit, on open.
  it('includes the current booking on an OCCUPIED unit, batched in one extra query', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('POC_HOUSEKEEPING'));
    mockPrisma.unit.findMany.mockResolvedValue([fakeUnit({ status: 'OCCUPIED' })]);
    mockPrisma.unitStatusEvent.findMany.mockResolvedValue([]);
    mockPrisma.bookingUnit.findMany.mockResolvedValue([
      { unitId: 'unit_1', booking: { id: 'booking_1', referenceNo: '83887', guestName: 'Roel Villagomez', status: 'CHECKED_IN' } },
    ]);

    const res = await request(createApp()).get('/api/v1/units').set('Cookie', authCookie());

    expect(res.status).toBe(200);
    // status included (added 2026-11-05, spec.md §13 decision 16
    // correction): the unit card's CONFIRMED-vs-CHECKED_IN distinction
    // depends on this field actually being here.
    expect(res.body.units[0].currentBooking).toEqual({
      bookingId: 'booking_1',
      referenceNo: '83887',
      guestName: 'Roel Villagomez',
      status: 'CHECKED_IN',
    });
    // Bug caught in review, 2026-11-05 (spec.md §13 decision 16): after
    // a room move, a unit has a released BookingUnit row and a live
    // one, both potentially matching a non-excluded booking — without
    // releasedAt: null, the Map this builds keys by unitId and the last
    // matching row wins arbitrarily, so the unit card could show the
    // wrong guest's name and booking ID.
    expect(mockPrisma.bookingUnit.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ unitId: { in: ['unit_1'] }, releasedAt: null }) }),
    );
  });

  // Re-plan, spec.md §13 decision 16: a pre-arrival booking moves its
  // unit to OCCUPIED immediately, so its card must show status:
  // CONFIRMED — the one field that lets the frontend distinguish it
  // from an actual guest, per the client's own request.
  it('currentBooking carries status: CONFIRMED for a pre-arrival booking (room OCCUPIED, nobody there yet)', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('POC_HOUSEKEEPING'));
    mockPrisma.unit.findMany.mockResolvedValue([fakeUnit({ status: 'OCCUPIED' })]);
    mockPrisma.unitStatusEvent.findMany.mockResolvedValue([]);
    mockPrisma.bookingUnit.findMany.mockResolvedValue([
      { unitId: 'unit_1', booking: { id: 'booking_1', referenceNo: 'EXT-200', guestName: 'Jane Dela Cruz', status: 'CONFIRMED' } },
    ]);

    const res = await request(createApp()).get('/api/v1/units').set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.units[0].currentBooking.status).toBe('CONFIRMED');
  });

  it('currentBooking is null for a non-OCCUPIED unit, and the booking-unit query is skipped entirely', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('POC_HOUSEKEEPING'));
    mockPrisma.unit.findMany.mockResolvedValue([fakeUnit({ status: 'VACANT_DIRTY' })]);
    mockPrisma.unitStatusEvent.findMany.mockResolvedValue([]);

    const res = await request(createApp()).get('/api/v1/units').set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.units[0].currentBooking).toBeNull();
    expect(mockPrisma.bookingUnit.findMany).not.toHaveBeenCalled();
  });

  it('surfaces latestNote from any status-change panel, only while it is still attached to the latest event', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('POC_HOUSEKEEPING'));
    mockPrisma.unit.findMany.mockResolvedValue([fakeUnit()]);
    mockPrisma.unitStatusEvent.findMany.mockResolvedValue([
      { unitId: 'unit_1', note: 'staff forgot to mark this cleaned yesterday' },
    ]);

    const res = await request(createApp()).get('/api/v1/units').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.units[0].latestNote).toBe('staff forgot to mark this cleaned yesterday');
  });

  it('serializes UnitType Decimal fields as plain numbers', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('POC_HOUSEKEEPING'));
    mockPrisma.unitType.findMany.mockResolvedValue([
      {
        id: 'type_1',
        name: 'Standard Room',
        description: null,
        defaultCapacity: 2,
        baseRate: { toString: () => '1500.00' },
        dayTourRate: null,
        extraPersonRate: { toString: () => '200.00' },
        colorHex: null,
        isActive: true,
        sortOrder: 0,
      },
    ]);

    const res = await request(createApp()).get('/api/v1/unit-types').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.unitTypes[0].baseRate).toBe(1500);
    expect(res.body.unitTypes[0].dayTourRate).toBeNull();
    expect(res.body.unitTypes[0].extraPersonRate).toBe(200);
  });
});

// Setup Rooms (client-directed feature, 2026-11-04): these endpoints
// already existed, but nothing in the web app ever called them — there
// was no test coverage either. Adding it alongside the new UI, plus the
// These predate this comment but had no test coverage until added here.
describe('POST/PATCH /api/v1/unit-types', () => {
  it('requires unittype:manage, not just unit:read', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('POC_HOUSEKEEPING'));
    const res = await request(createApp())
      .post('/api/v1/unit-types')
      .set('Cookie', authCookie())
      .send({ name: 'Standard Room', defaultCapacity: 2, baseRate: 1500 });
    expect(res.status).toBe(403);
  });

  it('creates a unit type', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.unitType.create.mockResolvedValue({
      id: 'type_1',
      name: 'Standard Room',
      description: null,
      defaultCapacity: 2,
      baseRate: { toString: () => '1500.00' },
      dayTourRate: null,
      extraPersonRate: null,
      colorHex: null,
      isActive: true,
      sortOrder: 0,
    });

    const res = await request(createApp())
      .post('/api/v1/unit-types')
      .set('Cookie', authCookie())
      .send({ name: 'Standard Room', defaultCapacity: 2, baseRate: 1500 });

    expect(res.status).toBe(201);
    expect(res.body.unitType.baseRate).toBe(1500);
  });

  it('updates an existing unit type', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    // First call is the existing-type lookup; second is the new
    // active-name-conflict check (null: no conflict for 'Deluxe Room').
    mockPrisma.unitType.findFirst.mockResolvedValueOnce({ id: 'type_1', name: 'Standard Room' }).mockResolvedValueOnce(null);
    mockPrisma.unitType.update.mockResolvedValue({
      id: 'type_1',
      name: 'Deluxe Room',
      description: null,
      defaultCapacity: 2,
      baseRate: { toString: () => '1800.00' },
      dayTourRate: null,
      extraPersonRate: null,
      colorHex: null,
      isActive: true,
      sortOrder: 0,
    });

    const res = await request(createApp())
      .patch('/api/v1/unit-types/type_1')
      .set('Cookie', authCookie())
      .send({ name: 'Deluxe Room', baseRate: 1800 });

    expect(res.status).toBe(200);
    expect(res.body.unitType.name).toBe('Deluxe Room');
  });

  // Caught live, 2026-11-18: UnitType.name has no uniqueness
  // constraint, and the client created a duplicate "Family Room" by
  // accident. Validated in the service layer, scoped to active types
  // only — never a DB constraint, since the client's own data already
  // has a duplicate a migration would fail against.
  it('409s creating a unit type with the same name as an existing active one', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.unitType.findFirst.mockResolvedValue({ id: 'type_1', name: 'Family Room', isActive: true });

    const res = await request(createApp())
      .post('/api/v1/unit-types')
      .set('Cookie', authCookie())
      .send({ name: 'Family Room', defaultCapacity: 4, baseRate: 2500 });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('UNIT_TYPE_NAME_TAKEN');
    expect(mockPrisma.unitType.create).not.toHaveBeenCalled();
  });

  it('409s renaming a unit type to a name an existing active one already uses', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.unitType.findFirst
      .mockResolvedValueOnce({ id: 'type_2', name: 'Deluxe Room' }) // the existing-type lookup
      .mockResolvedValueOnce({ id: 'type_1', name: 'Family Room', isActive: true }); // the conflict check

    const res = await request(createApp())
      .patch('/api/v1/unit-types/type_2')
      .set('Cookie', authCookie())
      .send({ name: 'Family Room' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('UNIT_TYPE_NAME_TAKEN');
    expect(mockPrisma.unitType.update).not.toHaveBeenCalled();
  });

  it('does not conflict-check a rename that leaves the name unchanged', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.unitType.findFirst.mockResolvedValueOnce({ id: 'type_1', name: 'Family Room' });
    mockPrisma.unitType.update.mockResolvedValue({
      id: 'type_1',
      name: 'Family Room',
      description: null,
      defaultCapacity: 5,
      baseRate: { toString: () => '2500.00' },
      dayTourRate: null,
      extraPersonRate: null,
      colorHex: null,
      isActive: true,
      sortOrder: 0,
    });

    const res = await request(createApp())
      .patch('/api/v1/unit-types/type_1')
      .set('Cookie', authCookie())
      .send({ name: 'Family Room', defaultCapacity: 5 });

    expect(res.status).toBe(200);
    // Only one findFirst call — the existing-type lookup — since the
    // name didn't actually change.
    expect(mockPrisma.unitType.findFirst).toHaveBeenCalledTimes(1);
  });

  // Caught live, 2026-11-18: the client created a duplicate "Family
  // Room" by accident with no way to remove it — only Deactivate
  // existed. Same rule already used for a folio charge or a payment:
  // delete when nothing depends on it, refuse clearly when it does.
  describe('DELETE /api/v1/unit-types/:id', () => {
    it('deletes a unit type no Unit references, and deletes its RatePlanRate rows with it', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
      mockPrisma.unitType.findFirst.mockResolvedValue({ id: 'type_1', name: 'Family Room (dup)', deletedAt: null });
      mockPrisma.unit.count.mockResolvedValue(0);

      const res = await request(createApp()).delete('/api/v1/unit-types/type_1').set('Cookie', authCookie());

      expect(res.status).toBe(204);
      expect(mockPrisma.ratePlanRate.deleteMany).toHaveBeenCalledWith({ where: { unitTypeId: 'type_1' } });
      expect(mockPrisma.unitType.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'type_1' }, data: { deletedAt: expect.any(Date) } }),
      );
    });

    it('404s deleting an unknown unit type', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
      mockPrisma.unitType.findFirst.mockResolvedValue(null);
      const res = await request(createApp()).delete('/api/v1/unit-types/missing').set('Cookie', authCookie());
      expect(res.status).toBe(404);
    });

    it('409s deleting a unit type still used by rooms, naming the count, and deletes nothing', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
      mockPrisma.unitType.findFirst.mockResolvedValue({ id: 'type_1', name: 'Standard Room', deletedAt: null });
      mockPrisma.unit.count.mockResolvedValue(3);

      const res = await request(createApp()).delete('/api/v1/unit-types/type_1').set('Cookie', authCookie());

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('UNIT_TYPE_IN_USE');
      expect(res.body.error.message).toContain('3 rooms');
      expect(mockPrisma.unitType.update).not.toHaveBeenCalled();
      expect(mockPrisma.ratePlanRate.deleteMany).not.toHaveBeenCalled();
    });

    it('refuses deleting without unittype:manage', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(userWithRole('POC_HOUSEKEEPING'));
      const res = await request(createApp()).delete('/api/v1/unit-types/type_1').set('Cookie', authCookie());
      expect(res.status).toBe(403);
    });
  });
});

// Real gap found live-testing, 2026-08-25: there was no UI to add, edit,
// or deactivate a unit at all, despite these routes already existing —
// only the frontend was missing. Adding coverage for the routes
// themselves alongside the new UI.
describe('POST /api/v1/units', () => {
  it('requires unit:manage, not just unit:read', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('HOUSEKEEPING_STAFF'));
    const res = await request(createApp())
      .post('/api/v1/units')
      .set('Cookie', authCookie())
      .send({ code: 'R21', name: 'Room 21', unitTypeId: 'type_1', type: 'ROOM' });
    expect(res.status).toBe(403);
  });

  it('rejects an unknown unitTypeId', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.unitType.findFirst.mockResolvedValue(null);
    const res = await request(createApp())
      .post('/api/v1/units')
      .set('Cookie', authCookie())
      .send({ code: 'R21', name: 'Room 21', unitTypeId: 'type_1', type: 'ROOM' });
    expect(res.status).toBe(422);
    expect(mockPrisma.unit.create).not.toHaveBeenCalled();
  });

  it('rejects a code already in use', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.unitType.findFirst.mockResolvedValue({ id: 'type_1', defaultCapacity: 2 });
    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnit({ code: 'R21' }));
    const res = await request(createApp())
      .post('/api/v1/units')
      .set('Cookie', authCookie())
      .send({ code: 'R21', name: 'Room 21', unitTypeId: 'type_1', type: 'ROOM' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('UNIT_CODE_TAKEN');
  });

  it('creates a unit, defaulting capacity from the unit type when not given', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.unitType.findFirst.mockResolvedValue({ id: 'type_1', defaultCapacity: 4 });
    mockPrisma.unit.findFirst.mockResolvedValue(null);
    mockPrisma.unit.create.mockResolvedValue(fakeUnit({ code: 'R21', name: 'Room 21', capacity: 4 }));

    const res = await request(createApp())
      .post('/api/v1/units')
      .set('Cookie', authCookie())
      .send({ code: 'R21', name: 'Room 21', unitTypeId: 'type_1', type: 'ROOM' });

    expect(res.status).toBe(201);
    expect(mockPrisma.unit.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ code: 'R21', name: 'Room 21', type: 'ROOM', capacity: 4 }) }),
    );
  });

  // Client decision, 2026-08-25: choosing the type is the form's first
  // field, and every UNIT_KIND_KEYS value must reach the service intact
  // — including COMMON_AREA/FACILITY, not just ROOM/COTTAGE.
  it.each(['ROOM', 'COTTAGE', 'COMMON_AREA', 'FACILITY'])('accepts %s as a unit type', async (type) => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.unitType.findFirst.mockResolvedValue({ id: 'type_1', defaultCapacity: 1 });
    mockPrisma.unit.findFirst.mockResolvedValue(null);
    mockPrisma.unit.create.mockResolvedValue(fakeUnit({ type }));

    const res = await request(createApp())
      .post('/api/v1/units')
      .set('Cookie', authCookie())
      .send({ code: 'X01', name: 'Test unit', unitTypeId: 'type_1', type });

    expect(res.status).toBe(201);
  });
});

describe('PATCH /api/v1/units/:id', () => {
  it('requires unit:manage', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('HOUSEKEEPING_STAFF'));
    const res = await request(createApp()).patch('/api/v1/units/unit_1').set('Cookie', authCookie()).send({ name: 'New name' });
    expect(res.status).toBe(403);
  });

  it('returns 404 for an unknown unit', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.unit.findFirst.mockResolvedValue(null);
    const res = await request(createApp()).patch('/api/v1/units/does_not_exist').set('Cookie', authCookie()).send({ name: 'New name' });
    expect(res.status).toBe(404);
  });

  it('edits a unit\'s own details', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnit());
    mockPrisma.unit.update.mockResolvedValue(fakeUnit({ name: 'Room 101 Deluxe', capacity: 3 }));

    const res = await request(createApp())
      .patch('/api/v1/units/unit_1')
      .set('Cookie', authCookie())
      .send({ name: 'Room 101 Deluxe', capacity: 3 });

    expect(res.status).toBe(200);
    expect(res.body.unit.name).toBe('Room 101 Deluxe');
    expect(mockPrisma.unit.update).toHaveBeenCalledWith({
      where: { id: 'unit_1' },
      data: { name: 'Room 101 Deluxe', capacity: 3 },
    });
  });

  // Soft-delete/deactivate, per the client's explicit request — same
  // isActive-toggle pattern as AmenityItem/MenuItem, no hard delete.
  it('deactivates a unit via isActive', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnit({ isActive: true }));
    mockPrisma.unit.update.mockResolvedValue(fakeUnit({ isActive: false }));

    const res = await request(createApp()).patch('/api/v1/units/unit_1').set('Cookie', authCookie()).send({ isActive: false });

    expect(res.status).toBe(200);
    expect(res.body.unit.isActive).toBe(false);
    expect(mockPrisma.unit.update).toHaveBeenCalledWith({ where: { id: 'unit_1' }, data: { isActive: false } });
  });
});

// Spec.md §13 decision 36 (2026-11-19): a soft delete, reversing the
// original 2026-08-25 hard-delete design. Client's own words: "i cannot
// delete rooms with history. it should be able to delete but still on
// reporting. the code cannot be reused for records purposes."
describe('DELETE /api/v1/units/:id', () => {
  it('requires unit:manage', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('HOUSEKEEPING_STAFF'));
    const res = await request(createApp()).delete('/api/v1/units/unit_1').set('Cookie', authCookie());
    expect(res.status).toBe(403);
    expect(mockPrisma.unit.update).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown unit', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.unit.findFirst.mockResolvedValue(null);
    const res = await request(createApp()).delete('/api/v1/units/does_not_exist').set('Cookie', authCookie());
    expect(res.status).toBe(404);
  });

  it('refuses to delete a still-active unit', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnit({ isActive: true }));
    const res = await request(createApp()).delete('/api/v1/units/unit_1').set('Cookie', authCookie());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('UNIT_STILL_ACTIVE');
    expect(mockPrisma.unit.update).not.toHaveBeenCalled();
  });

  // The question the client specifically asked to have answered: a unit
  // with real history (bookings, work orders, status events — any of
  // it) is no longer refused. It's never even counted any more — a soft
  // delete has nothing for a history check to protect.
  it('soft-deletes an inactive unit that has real history, without counting or querying any of it', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnit({ isActive: false }));
    mockPrisma.unit.update.mockResolvedValue(fakeUnit({ isActive: false, deletedAt: new Date() }));

    const res = await request(createApp()).delete('/api/v1/units/unit_1').set('Cookie', authCookie());

    expect(res.status).toBe(204);
    expect(mockPrisma.unit.update).toHaveBeenCalledWith({
      where: { id: 'unit_1' },
      data: { deletedAt: expect.any(Date) },
    });
    expect(mockPrisma.unit.delete).not.toHaveBeenCalled();
    expect(mockPrisma.unitStatusEvent.count).not.toHaveBeenCalled();
    expect(mockPrisma.bookingUnit.count).not.toHaveBeenCalled();
    expect(mockPrisma.workOrder.count).not.toHaveBeenCalled();
    expect(mockPrisma.amenityRequest.count).not.toHaveBeenCalled();
    expect(mockPrisma.fnbOrder.count).not.toHaveBeenCalled();
    expect(mockPrisma.inspection.count).not.toHaveBeenCalled();
  });

  it('deletes an inactive unit with zero history the same way — soft delete, not removal', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnit({ isActive: false }));
    mockPrisma.unit.update.mockResolvedValue(fakeUnit({ isActive: false, deletedAt: new Date() }));

    const res = await request(createApp()).delete('/api/v1/units/unit_1').set('Cookie', authCookie());

    expect(res.status).toBe(204);
    expect(mockPrisma.unit.update).toHaveBeenCalledWith({
      where: { id: 'unit_1' },
      data: { deletedAt: expect.any(Date) },
    });
  });

  // The client's own third requirement, confirmed rather than assumed:
  // a deleted unit's code must never become reusable. createUnit's own
  // conflict check has no deletedAt filter, so it already matches a
  // soft-deleted row too — this pins that behavior down as a test, not
  // just a doc-comment claim.
  it("a deleted unit's code is still rejected as taken on create", async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.unitType.findFirst.mockResolvedValue({ id: 'type_1', defaultCapacity: 2 });
    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnit({ code: 'R01', deletedAt: new Date() }));

    const res = await request(createApp())
      .post('/api/v1/units')
      .set('Cookie', authCookie())
      .send({ code: 'R01', name: 'Room 1', unitTypeId: 'type_1', type: 'ROOM' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('UNIT_CODE_TAKEN');
    expect(mockPrisma.unit.findFirst).toHaveBeenCalledWith({ where: { code: 'R01' } });
  });
});

describe('GET /api/v1/units/orderable', () => {
  it('requires fnb:create, not unit:read', async () => {
    // POC_HOUSEKEEPING holds unit:read but not fnb:create — proves this
    // route is gated on the F&B permission, not the general one.
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('POC_HOUSEKEEPING'));
    const res = await request(createApp()).get('/api/v1/units/orderable').set('Cookie', authCookie());
    expect(res.status).toBe(403);
  });

  // RESTAURANT_STAFF holds fnb:create but no unit:read at all (spec
  // §5.4's "unit read" row) — the whole reason this narrowly-scoped
  // route exists rather than reusing GET /units.
  it('succeeds for RESTAURANT_STAFF, who has fnb:create but not unit:read', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESTAURANT_STAFF'));
    mockPrisma.unit.findMany.mockResolvedValue([fakeUnit({ status: 'OCCUPIED' })]);

    const res = await request(createApp()).get('/api/v1/units/orderable').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.units).toHaveLength(1);
    expect(res.body.units[0].status).toBe('OCCUPIED');
  });
});

describe('POST /api/v1/units/:id/status', () => {
  it('allows a caller with unit:update_status to move CLEANED -> READY directly — no QC handoff (client decision, 2026-08-22, INSPECTED retired)', async () => {
    // Formerly a two-hop hand-off (CLEANED -> INSPECTED via workorder:verify,
    // then an automatic-only INSPECTED -> READY): the client corrected this
    // to a single manual step gated by the same housekeeping permission as
    // the rest of the cycle, since the person who cleans the room is the
    // same person who marks it ready.
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('POC_HOUSEKEEPING'));
    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnit({ status: 'CLEANED', version: 3 }));
    mockPrisma.unit.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(createApp())
      .post('/api/v1/units/unit_1/status')
      .set('Cookie', authCookie())
      .send({ toStatus: 'READY', version: 3 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'unit_1', status: 'READY', version: 4 });
    expect(mockPrisma.unit.updateMany).toHaveBeenCalledWith({
      where: { id: 'unit_1', version: 3 },
      data: { status: 'READY', version: { increment: 1 } },
    });
    expect(mockPrisma.unitStatusEvent.create).toHaveBeenCalledWith({
      data: {
        unitId: 'unit_1',
        fromStatus: 'CLEANED',
        toStatus: 'READY',
        actorId: 'user_1',
        note: undefined,
        source: 'MANUAL',
      },
    });
    // Spec §9.1: channel `property`, event `unit.status.changed`, payload
    // carries enough for the grid to patch its own state without a refetch.
    expect(mockRealtimeEmit).toHaveBeenCalledWith(
      'property',
      'unit.status.changed',
      expect.objectContaining({
        entityId: 'unit_1',
        actorId: 'user_1',
        fromStatus: 'CLEANED',
        toStatus: 'READY',
        version: 4,
        note: null,
      }),
    );
  });

  it('does not fail the status change when the realtime broadcast itself fails', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('POC_HOUSEKEEPING'));
    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnit({ status: 'CLEANED', version: 3 }));
    mockPrisma.unit.updateMany.mockResolvedValue({ count: 1 });
    mockRealtimeEmit.mockRejectedValue(new Error('Supabase Realtime unreachable'));

    const res = await request(createApp())
      .post('/api/v1/units/unit_1/status')
      .set('Cookie', authCookie())
      .send({ toStatus: 'READY', version: 3 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'unit_1', status: 'READY', version: 4 });
  });

  it('a room attendant holding only unit:update_status can now do CLEANED -> READY too — the QC gate is gone (previously 403 before INSPECTED was retired)', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('HOUSEKEEPING_STAFF'));
    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnit({ status: 'CLEANED', version: 3 }));
    mockPrisma.unit.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(createApp())
      .post('/api/v1/units/unit_1/status')
      .set('Cookie', authCookie())
      .send({ toStatus: 'READY', version: 3 });

    expect(res.status).toBe(200);
  });

  it('rejects INSPECTED as a target status — it is no longer a valid enum value to transition into', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('SYSTEM_ADMIN'));

    const res = await request(createApp())
      .post('/api/v1/units/unit_1/status')
      .set('Cookie', authCookie())
      .send({ toStatus: 'INSPECTED', version: 3 });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(mockPrisma.unit.updateMany).not.toHaveBeenCalled();
  });

  it('lets a room attendant do their own allowed step, CLEANING -> CLEANED', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('HOUSEKEEPING_STAFF'));
    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnit({ status: 'CLEANING', version: 1 }));
    mockPrisma.unit.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(createApp())
      .post('/api/v1/units/unit_1/status')
      .set('Cookie', authCookie())
      .send({ toStatus: 'CLEANED', version: 1 });

    expect(res.status).toBe(200);
  });

  it('rejects skipping a step in the cycle with 422 INVALID_TRANSITION', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('SYSTEM_ADMIN'));
    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnit({ status: 'VACANT_DIRTY', version: 0 }));

    const res = await request(createApp())
      .post('/api/v1/units/unit_1/status')
      .set('Cookie', authCookie())
      .send({ toStatus: 'CLEANED', version: 0 });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVALID_TRANSITION');
  });

  it('rejects the automatic-only READY -> OCCUPIED transition for a non-SYSTEM_ADMIN caller, even one holding unit:manage', async () => {
    // RESORT_MANAGER also holds unit:manage (same as SYSTEM_ADMIN) but is
    // deliberately excluded from the override — client decision,
    // 2026-08-22: this is a stopgap testing tool, not a normal
    // operational path RESORT_MANAGER should reach for day to day.
    // READY -> OCCUPIED is one of only two automatic-only transitions
    // remaining now that INSPECTED (and its automatic-only INSPECTED ->
    // READY hop) has been retired — CLEANED -> READY is a normal manual
    // step now, so no override applies to it any more.
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnit({ status: 'READY', version: 5 }));

    const res = await request(createApp())
      .post('/api/v1/units/unit_1/status')
      .set('Cookie', authCookie())
      .send({ toStatus: 'OCCUPIED', version: 5 });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVALID_TRANSITION');
    expect(mockPrisma.unit.updateMany).not.toHaveBeenCalled();
  });

  it('allows SYSTEM_ADMIN to override the automatic-only READY -> OCCUPIED transition, and audits it distinctly from a plain update', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('SYSTEM_ADMIN'));
    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnit({ status: 'READY', version: 5 }));
    mockPrisma.unit.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(createApp())
      .post('/api/v1/units/unit_1/status')
      .set('Cookie', authCookie())
      .send({ toStatus: 'OCCUPIED', version: 5, note: 'unsticking manually, no booking module yet' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'unit_1', status: 'OCCUPIED', version: 6 });
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'UNIT_STATUS_AUTOMATIC_TRANSITION_OVERRIDE',
          entity: 'Unit',
          entityId: 'unit_1',
          actorId: 'user_1',
        }),
      }),
    );
  });

  it('CLEANED -> READY needs no override any more — a plain unit:update_status caller succeeds where only SYSTEM_ADMIN could before', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('HOUSEKEEPING_STAFF'));
    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnit({ status: 'CLEANED', version: 5 }));
    mockPrisma.unit.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(createApp())
      .post('/api/v1/units/unit_1/status')
      .set('Cookie', authCookie())
      .send({ toStatus: 'READY', version: 5 });

    expect(res.status).toBe(200);
    // Not an override — no distinct audit tag, just the generic UPDATE
    // row the audit extension writes for every mutated Unit.
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('returns 409 on a stale version (concurrent edit)', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('HOUSEKEEPING_STAFF'));
    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnit({ status: 'CLEANING', version: 5 }));
    mockPrisma.unit.updateMany.mockResolvedValue({ count: 0 });

    const res = await request(createApp())
      .post('/api/v1/units/unit_1/status')
      .set('Cookie', authCookie())
      .send({ toStatus: 'CLEANED', version: 1 });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('VERSION_CONFLICT');
  });

  it('returns 404 for an unknown unit', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('SYSTEM_ADMIN'));
    mockPrisma.unit.findFirst.mockResolvedValue(null);

    const res = await request(createApp())
      .post('/api/v1/units/does_not_exist/status')
      .set('Cookie', authCookie())
      .send({ toStatus: 'CLEANING', version: 0 });

    expect(res.status).toBe(404);
  });
});

// Spec.md §13 decision 34 (2026-11-18): morning housekeeping — change
// many rooms' status at once, reusing changeUnitStatus per room so
// every transition/permission/version check already proven above
// keeps working unchanged.
describe('POST /api/v1/units/bulk-status', () => {
  it('changes every selected room, reading each one\'s own current version fresh rather than trusting the request', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('HOUSEKEEPING_STAFF'));
    const unit1 = fakeUnit({ id: 'unit_1', code: 'R01', status: 'VACANT_DIRTY', version: 2 });
    const unit2 = fakeUnit({ id: 'unit_2', code: 'R02', status: 'VACANT_DIRTY', version: 5 });
    // Two findFirst calls per room: bulkChangeUnitStatus's own read (for
    // the current version and the code to report), then
    // changeUnitStatus's own internal read — nothing changes between
    // them, so both see the same row.
    mockPrisma.unit.findFirst
      .mockResolvedValueOnce(unit1)
      .mockResolvedValueOnce(unit1)
      .mockResolvedValueOnce(unit2)
      .mockResolvedValueOnce(unit2);
    mockPrisma.unit.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(createApp())
      .post('/api/v1/units/bulk-status')
      .set('Cookie', authCookie())
      .send({ unitIds: ['unit_1', 'unit_2'], toStatus: 'CLEANING' });

    expect(res.status).toBe(200);
    expect(res.body.succeededCount).toBe(2);
    expect(res.body.failedCount).toBe(0);
    expect(res.body.results).toEqual([
      { unitId: 'unit_1', code: 'R01', status: 'OK' },
      { unitId: 'unit_2', code: 'R02', status: 'OK' },
    ]);
    expect(mockPrisma.unit.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: 'unit_1', version: 2 },
      data: { status: 'CLEANING', version: { increment: 1 } },
    });
    expect(mockPrisma.unit.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: 'unit_2', version: 5 },
      data: { status: 'CLEANING', version: { increment: 1 } },
    });
  });

  it('reports a partial result — one room succeeds, one 409s on a stale version, one 404s — without rolling back the rest', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('HOUSEKEEPING_STAFF'));
    const unit1 = fakeUnit({ id: 'unit_1', code: 'R01', status: 'VACANT_DIRTY', version: 2 });
    const unit2 = fakeUnit({ id: 'unit_2', code: 'R02', status: 'VACANT_DIRTY', version: 2 });
    mockPrisma.unit.findFirst
      .mockResolvedValueOnce(unit1)
      .mockResolvedValueOnce(unit1)
      .mockResolvedValueOnce(unit2)
      .mockResolvedValueOnce(unit2)
      .mockResolvedValueOnce(null); // unit_3: bulk's own pre-check 404s before changeUnitStatus is even called
    mockPrisma.unit.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

    const res = await request(createApp())
      .post('/api/v1/units/bulk-status')
      .set('Cookie', authCookie())
      .send({ unitIds: ['unit_1', 'unit_2', 'unit_3'], toStatus: 'CLEANING' });

    expect(res.status).toBe(200);
    expect(res.body.succeededCount).toBe(1);
    expect(res.body.failedCount).toBe(2);
    expect(res.body.results[0]).toEqual({ unitId: 'unit_1', code: 'R01', status: 'OK' });
    expect(res.body.results[1]).toMatchObject({ unitId: 'unit_2', code: 'R02', status: 'FAILED' });
    expect(res.body.results[1].message).toMatch(/refresh and try again/);
    expect(res.body.results[2]).toEqual({ unitId: 'unit_3', code: null, status: 'FAILED', message: 'Unit not found' });
    // unit_1's successful update is never undone by unit_2/unit_3's failures.
    expect(mockPrisma.unit.updateMany).toHaveBeenCalledTimes(2);
  });

  // Spec.md §13 decision 35 (2026-11-19): the client's own closing
  // concern — a bulk action must never put a room into OCCUPIED without
  // a real booking — hardened at the service layer rather than left to
  // depend on the frontend never sending it. Unlike the single-room
  // route, a SYSTEM_ADMIN actor normally CAN override READY->OCCUPIED
  // (changeUnitStatus's own automatic-trigger escape hatch) — bulk
  // refuses OCCUPIED outright, before the loop even starts, independent
  // of role, so that override can never fire across a whole batch.
  it('refuses OCCUPIED as a bulk target outright, even for a SYSTEM_ADMIN who could override it on a single room', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('SYSTEM_ADMIN'));

    const res = await request(createApp())
      .post('/api/v1/units/bulk-status')
      .set('Cookie', authCookie())
      .send({ unitIds: ['unit_1'], toStatus: 'OCCUPIED' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVALID_TRANSITION');
    expect(res.body.error.message).toMatch(/happens automatically/);
    expect(mockPrisma.unit.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.unit.updateMany).not.toHaveBeenCalled();
  });

  it('422s the whole call for more than 50 unitIds', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('HOUSEKEEPING_STAFF'));
    const res = await request(createApp())
      .post('/api/v1/units/bulk-status')
      .set('Cookie', authCookie())
      .send({ unitIds: Array.from({ length: 51 }, (_, i) => `unit_${i}`), toStatus: 'CLEANING' });
    expect(res.status).toBe(422);
  });
});

describe('POST /api/v1/units/:id/force-status', () => {
  it('rejects a caller without unit:force_status', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));

    const res = await request(createApp())
      .post('/api/v1/units/unit_1/force-status')
      .set('Cookie', authCookie())
      .send({ toStatus: 'READY', version: 3, note: 'fixing stale data' });

    expect(res.status).toBe(403);
    expect(mockPrisma.unit.updateMany).not.toHaveBeenCalled();
  });

  it('succeeds with an empty/missing note — note is optional, not required (client decision, 2026-08-22)', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('SYSTEM_ADMIN'));
    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnit({ status: 'CLEANED', version: 3 }));
    mockPrisma.unit.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(createApp())
      .post('/api/v1/units/unit_1/force-status')
      .set('Cookie', authCookie())
      .send({ toStatus: 'READY', version: 3, note: '' });

    expect(res.status).toBe(200);
    expect(mockPrisma.unit.updateMany).toHaveBeenCalledWith({
      where: { id: 'unit_1', version: 3 },
      data: { status: 'READY', version: { increment: 1 } },
    });
    expect(mockPrisma.unitStatusEvent.create).toHaveBeenCalledWith({
      data: {
        unitId: 'unit_1',
        fromStatus: 'CLEANED',
        toStatus: 'READY',
        actorId: 'user_1',
        note: '',
        source: 'FORCED_CORRECTION',
      },
    });

    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnit({ status: 'CLEANED', version: 3 }));
    const res2 = await request(createApp())
      .post('/api/v1/units/unit_1/force-status')
      .set('Cookie', authCookie())
      .send({ toStatus: 'READY', version: 3 });

    expect(res2.status).toBe(200);
    expect(mockPrisma.unitStatusEvent.create).toHaveBeenCalledWith({
      data: {
        unitId: 'unit_1',
        fromStatus: 'CLEANED',
        toStatus: 'READY',
        actorId: 'user_1',
        note: undefined,
        source: 'FORCED_CORRECTION',
      },
    });
  });

  it('allows SYSTEM_ADMIN to jump directly to any status, bypassing the transition table, and audits it distinctly', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('SYSTEM_ADMIN'));
    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnit({ status: 'VACANT_DIRTY', version: 0 }));
    mockPrisma.unit.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(createApp())
      .post('/api/v1/units/unit_1/force-status')
      .set('Cookie', authCookie())
      .send({ toStatus: 'OCCUPIED', version: 0, note: 'guest is already checked in, staff forgot to update' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'unit_1', status: 'OCCUPIED', version: 1 });
    expect(mockPrisma.unit.updateMany).toHaveBeenCalledWith({
      where: { id: 'unit_1', version: 0 },
      data: { status: 'OCCUPIED', version: { increment: 1 } },
    });
    expect(mockPrisma.unitStatusEvent.create).toHaveBeenCalledWith({
      data: {
        unitId: 'unit_1',
        fromStatus: 'VACANT_DIRTY',
        toStatus: 'OCCUPIED',
        actorId: 'user_1',
        note: 'guest is already checked in, staff forgot to update',
        source: 'FORCED_CORRECTION',
      },
    });
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'UNIT_STATUS_FORCED_CORRECTION',
          entity: 'Unit',
          entityId: 'unit_1',
          actorId: 'user_1',
          after: expect.objectContaining({
            label: 'Forced correction — bypassed the normal status sequence',
          }),
        }),
      }),
    );
    expect(mockRealtimeEmit).toHaveBeenCalledWith(
      'property',
      'unit.status.changed',
      expect.objectContaining({
        entityId: 'unit_1',
        actorId: 'user_1',
        fromStatus: 'VACANT_DIRTY',
        toStatus: 'OCCUPIED',
        version: 1,
        note: 'guest is already checked in, staff forgot to update',
      }),
    );
  });

  it('returns 409 on a stale version', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('SYSTEM_ADMIN'));
    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnit({ status: 'CLEANED', version: 5 }));
    mockPrisma.unit.updateMany.mockResolvedValue({ count: 0 });

    const res = await request(createApp())
      .post('/api/v1/units/unit_1/force-status')
      .set('Cookie', authCookie())
      .send({ toStatus: 'READY', version: 1, note: 'correcting stale data' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('VERSION_CONFLICT');
  });

  it('rejects INSPECTED in the force-correction dropdown too — the 8-status dropdown is now 5 (client decision, 2026-08-22)', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('SYSTEM_ADMIN'));

    const res = await request(createApp())
      .post('/api/v1/units/unit_1/force-status')
      .set('Cookie', authCookie())
      .send({ toStatus: 'INSPECTED', version: 3, note: 'trying to force a retired status' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(mockPrisma.unit.updateMany).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown unit', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('SYSTEM_ADMIN'));
    mockPrisma.unit.findFirst.mockResolvedValue(null);

    const res = await request(createApp())
      .post('/api/v1/units/does_not_exist/force-status')
      .set('Cookie', authCookie())
      .send({ toStatus: 'READY', version: 0, note: 'correcting stale data' });

    expect(res.status).toBe(404);
  });
});

describe('GET /api/v1/units/dashboard', () => {
  it('requires unit:read', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESTAURANT_STAFF'));
    const res = await request(createApp()).get('/api/v1/units/dashboard').set('Cookie', authCookie());
    expect(res.status).toBe(403);
  });

  it('computes KPI counts and flags rooms dirty past the 3h threshold', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    const now = Date.now();
    const fourHoursAgo = new Date(now - 4 * 60 * 60 * 1000);
    const oneHourAgo = new Date(now - 60 * 60 * 1000);
    mockPrisma.unit.findMany.mockResolvedValue([
      fakeUnit({ id: 'unit_occupied', status: 'OCCUPIED', createdAt: fourHoursAgo }),
      fakeUnit({ id: 'unit_ready', status: 'READY', createdAt: fourHoursAgo }),
      fakeUnit({ id: 'unit_ooo', status: 'OUT_OF_ORDER', createdAt: fourHoursAgo }),
      fakeUnit({ id: 'unit_dirty_long', code: '102', name: 'Room 102', status: 'VACANT_DIRTY', createdAt: fourHoursAgo }),
      fakeUnit({ id: 'unit_dirty_recent', code: '103', name: 'Room 103', status: 'VACANT_DIRTY', createdAt: oneHourAgo }),
    ]);
    mockPrisma.unitStatusEvent.findMany.mockResolvedValue([
      { unitId: 'unit_dirty_long', createdAt: fourHoursAgo },
      { unitId: 'unit_dirty_recent', createdAt: oneHourAgo },
    ]);

    const res = await request(createApp()).get('/api/v1/units/dashboard').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.kpi).toEqual({
      occupied: 1,
      ready: 1,
      dirty: 2,
      outOfOrder: 1,
      urgentOpenWorkOrders: 0,
      checkinsToday: 0,
      checkoutsToday: 0,
      openFnbOrders: 0,
      // RESORT_MANAGER holds both remittance:read and quotation:read in
      // the real seed, so both keys are present here (see the dedicated
      // permission-scoping tests below for the omitted-vs-present cases).
      pendingRemittances: 0,
      pendingQuotations: 0,
      // Always present, regardless of role/permissions — see
      // getUnitsDashboard's own doc comment for why lowStockItems is the
      // deliberate opposite of pendingRemittances/pendingQuotations.
      lowStockItems: 0,
    });
    expect(res.body.dirtyRooms).toHaveLength(1);
    expect(res.body.dirtyRooms[0]).toMatchObject({ id: 'unit_dirty_long', code: '102' });
  });

  it('falls back to the unit\'s createdAt when it has no status event yet', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000);
    mockPrisma.unit.findMany.mockResolvedValue([
      fakeUnit({ id: 'unit_never_touched', status: 'VACANT_DIRTY', createdAt: fourHoursAgo }),
    ]);
    mockPrisma.unitStatusEvent.findMany.mockResolvedValue([]);

    const res = await request(createApp()).get('/api/v1/units/dashboard').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.dirtyRooms).toHaveLength(1);
    expect(res.body.dirtyRooms[0].id).toBe('unit_never_touched');
  });

  // This test pins the end-to-end response shape (overdueMinutes, unit
  // info, merged into GET /units/dashboard). The where-clause itself
  // (dueAt < now && status not in DONE/VERIFIED/CANCELLED, per spec
  // §7.2) is exercised directly against the mocked findMany call in
  // workorders/service.test.ts.
  it('includes SLA-breached work orders in the attention queue', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.unit.findMany.mockResolvedValue([]);
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    mockPrisma.workOrder.findMany.mockResolvedValue([
      {
        id: 'wo_breached',
        referenceNo: 'LWW-WO-0009',
        title: 'Broken AC unit',
        department: 'MAINTENANCE',
        dueAt: twoHoursAgo,
        unit: { id: 'unit_5', code: '105', name: 'Room 105' },
      },
    ]);

    const res = await request(createApp()).get('/api/v1/units/dashboard').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.slaBreachedWorkOrders).toHaveLength(1);
    expect(res.body.slaBreachedWorkOrders[0]).toMatchObject({
      id: 'wo_breached',
      referenceNo: 'LWW-WO-0009',
      unitCode: '105',
    });
    expect(res.body.slaBreachedWorkOrders[0].overdueMinutes).toBeGreaterThanOrEqual(119);
  });

  it('returns an empty SLA-breach list when no work orders are past due', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.unit.findMany.mockResolvedValue([]);
    mockPrisma.workOrder.findMany.mockResolvedValue([]);

    const res = await request(createApp()).get('/api/v1/units/dashboard').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.slaBreachedWorkOrders).toEqual([]);
  });

  it('counts open urgent work orders via workOrder.count, not the SLA-breach findMany', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.unit.findMany.mockResolvedValue([]);
    mockPrisma.workOrder.count.mockResolvedValue(3);

    const res = await request(createApp()).get('/api/v1/units/dashboard').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.kpi.urgentOpenWorkOrders).toBe(3);
    expect(mockPrisma.workOrder.count).toHaveBeenCalledWith({
      where: { deletedAt: null, priority: 'URGENT', status: { notIn: ['DONE', 'VERIFIED', 'CANCELLED'] } },
    });
  });

  // Replaces spec's original "arrivals/departures today" concept, which
  // assumed a date-based internal reservation system this app no longer
  // has (see the Check-in/Check-out redesign) — counts real
  // UnitStatusEvent rows created today instead.
  // Spec §3.2: "'today'... resolve[s] against Asia/Manila regardless of
  // where the browser sits." Same principle applies server-side (a
  // Netlify function's process TZ is not guaranteed to be PHT) — this
  // pins the boundary to real Asia/Manila midnight, not just "midnight in
  // whatever TZ the test runner happens to be in," which `getHours() ===
  // 0` alone can't distinguish. Same UTC-offset-comparison approach as
  // jobs/ownerDigest.test.ts's "yesterday" boundary tests.
  it('counts check-ins and check-outs logged today from UnitStatusEvent, scoped to Asia/Manila midnight', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.unit.findMany.mockResolvedValue([]);
    mockPrisma.unitStatusEvent.count.mockResolvedValueOnce(5).mockResolvedValueOnce(4);

    const now = new Date();
    const nowInManila = new TZDate(now, 'Asia/Manila');
    const expectedStartOfToday = new TZDate(
      nowInManila.getFullYear(),
      nowInManila.getMonth(),
      nowInManila.getDate(),
      0,
      0,
      'Asia/Manila',
    );

    const res = await request(createApp()).get('/api/v1/units/dashboard').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.kpi.checkinsToday).toBe(5);
    expect(res.body.kpi.checkoutsToday).toBe(4);

    const calls = mockPrisma.unitStatusEvent.count.mock.calls;
    expect(calls[0]![0]).toMatchObject({ where: { fromStatus: 'READY', toStatus: 'OCCUPIED' } });
    expect(calls[0]![0].where.createdAt.gte.getTime()).toBe(expectedStartOfToday.getTime());
    expect(calls[1]![0]).toMatchObject({ where: { fromStatus: 'OCCUPIED', toStatus: 'VACANT_DIRTY' } });
    expect(calls[1]![0].where.createdAt.gte.getTime()).toBe(expectedStartOfToday.getTime());
  });

  // Real gap found live-testing, 2026-08-25: this KPI card said "Coming in
  // M5" until now. countOpenFnbOrders's own where-clause (RECEIVED/
  // PREPARING/READY, ADVANCE_ORDER lead-time gate) is exercised directly in
  // fnb/service.test.ts; this just pins that it reaches the dashboard.
  it('reports open F&B tickets via countOpenFnbOrders', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.unit.findMany.mockResolvedValue([]);
    mockPrisma.fnbOrder.count.mockResolvedValue(7);

    const res = await request(createApp()).get('/api/v1/units/dashboard').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.kpi.openFnbOrders).toBe(7);
  });

  // Same reasoning as the SLA-breach comment above: listOverdueAmenityRequests's
  // own where-clause (status OVERDUE, or ISSUED past dueBackAt) is exercised
  // directly in amenities/service.test.ts; this pins the end-to-end shape.
  it('includes overdue amenity requests in the attention queue', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.unit.findMany.mockResolvedValue([]);
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    mockPrisma.amenityRequest.findMany.mockResolvedValue([
      {
        id: 'amenity_overdue',
        referenceNo: 'LWW-AM-0004',
        status: 'OVERDUE',
        amenityItemName: 'Beach towel',
        amenityItem: { name: 'Beach towel' },
        unit: { code: '201' },
        dueBackAt: oneHourAgo,
      },
      {
        id: 'amenity_issued_past_due',
        referenceNo: 'LWW-AM-0005',
        status: 'ISSUED',
        amenityItemName: null,
        amenityItem: { name: 'Kayak' },
        unit: { code: '202' },
        dueBackAt: oneHourAgo,
      },
    ]);

    const res = await request(createApp()).get('/api/v1/units/dashboard').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.overdueAmenityRequests).toHaveLength(2);
    expect(res.body.overdueAmenityRequests[0]).toMatchObject({
      id: 'amenity_overdue',
      referenceNo: 'LWW-AM-0004',
      itemName: 'Beach towel',
      unitCode: '201',
    });
    expect(res.body.overdueAmenityRequests[0].overdueMinutes).toBeGreaterThanOrEqual(59);
    expect(res.body.overdueAmenityRequests[1]).toMatchObject({
      id: 'amenity_issued_past_due',
      itemName: 'Kayak',
      unitCode: '202',
    });
  });

  it('returns an empty overdue-amenities list when none are past due', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.unit.findMany.mockResolvedValue([]);
    mockPrisma.amenityRequest.findMany.mockResolvedValue([]);

    const res = await request(createApp()).get('/api/v1/units/dashboard').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.overdueAmenityRequests).toEqual([]);
  });

  // Client-directed feature, 2026-08-31: the first Command Center data
  // that isn't universally visible to every unit:read holder (see
  // getUnitsDashboard's own doc comment). POC_HOUSEKEEPING holds
  // unit:read but neither remittance:read nor quotation:read — this
  // pins that the two fields (and both queue arrays) are OMITTED from
  // the JSON entirely, not present as 0/[], since a 0 would be
  // indistinguishable on the wire from "the real count is zero."
  it('omits pendingRemittances/pendingQuotations and both queue arrays for a viewer without remittance:read/quotation:read', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('POC_HOUSEKEEPING'));
    mockPrisma.unit.findMany.mockResolvedValue([]);
    mockPrisma.remittanceRequest.findMany.mockResolvedValue([{ id: 'remit_1', referenceNo: 'RM-1', name: 'x', createdAt: new Date() }]);
    mockPrisma.quotationRequest.findMany.mockResolvedValue([{ id: 'quote_1', referenceNo: 'QT-1', name: 'y', createdAt: new Date() }]);

    const res = await request(createApp()).get('/api/v1/units/dashboard').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.kpi.pendingRemittances).toBeUndefined();
    expect(res.body.kpi.pendingQuotations).toBeUndefined();
    expect(res.body.remittanceRequests).toBeUndefined();
    expect(res.body.quotationRequests).toBeUndefined();
    expect('pendingRemittances' in res.body.kpi).toBe(false);
    expect('remittanceRequests' in res.body).toBe(false);
    // Confirms the omission is a genuine permission gate, not just an
    // empty result — the mocked data above is real and non-empty; a
    // caller without the permission must never see it, in any shape.
    expect(mockPrisma.remittanceRequest.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.quotationRequest.findMany).not.toHaveBeenCalled();
  });

  // ADMIN_STAFF holds both remittance:read and quotation:read in the
  // real seed (rolePermissions.ts) — confirms the fields are actually
  // wired end to end for a caller who does hold both.
  it('includes pendingRemittances/pendingQuotations and both queue arrays for a viewer with both permissions', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
    mockPrisma.unit.findMany.mockResolvedValue([]);
    const now = new Date();
    mockPrisma.remittanceRequest.findMany.mockResolvedValue([
      { id: 'remit_1', referenceNo: 'RM-260831-0001', name: 'Juan Dela Cruz', createdAt: now },
    ]);
    mockPrisma.quotationRequest.findMany.mockResolvedValue([
      { id: 'quote_1', referenceNo: 'QT-260831-0001', name: 'Maria Santos', createdAt: now },
    ]);

    const res = await request(createApp()).get('/api/v1/units/dashboard').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.kpi.pendingRemittances).toBe(1);
    expect(res.body.kpi.pendingQuotations).toBe(1);
    expect(res.body.remittanceRequests).toHaveLength(1);
    expect(res.body.remittanceRequests[0]).toMatchObject({ id: 'remit_1', referenceNo: 'RM-260831-0001' });
    expect(res.body.quotationRequests).toHaveLength(1);
    expect(res.body.quotationRequests[0]).toMatchObject({ id: 'quote_1', referenceNo: 'QT-260831-0001' });
  });

  // Only unresolved items count — same standard as dirty-room/SLA-breach/
  // overdue-amenity logic above. listPendingRemittances/
  // listPendingQuotations' own where-clauses (status FOR_VERIFICATION /
  // PENDING only) are pinned directly in their own service tests; this
  // confirms that filtering actually reaches the Command Center response.
  it('counts only FOR_VERIFICATION remittances and PENDING quotations, not VERIFIED/DONE ones', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('SYSTEM_ADMIN'));
    mockPrisma.unit.findMany.mockResolvedValue([]);
    // The service's own where-clause already excludes VERIFIED/DONE rows
    // at the query level, so the mock reflects that — this test's job is
    // to confirm the dashboard doesn't add a second, looser filter on
    // top that would let a resolved item back in.
    mockPrisma.remittanceRequest.findMany.mockResolvedValue([]);
    mockPrisma.quotationRequest.findMany.mockResolvedValue([]);

    const res = await request(createApp()).get('/api/v1/units/dashboard').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.kpi.pendingRemittances).toBe(0);
    expect(res.body.kpi.pendingQuotations).toBe(0);
    expect(res.body.remittanceRequests).toEqual([]);
    expect(res.body.quotationRequests).toEqual([]);
    expect(mockPrisma.remittanceRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { deletedAt: null, status: 'FOR_VERIFICATION' } }),
    );
    expect(mockPrisma.quotationRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { deletedAt: null, status: 'PENDING' } }),
    );
  });

  // Client-directed feature, 2026-08-31, same slice: low-stock items.
  // Deliberately the INVERSE of the remittance/quotation permission-
  // scoping tests above — the client's own explicit instruction was to
  // NOT restrict visibility here, unlike that feature. A caller holding
  // unit:read only, with none of stock:read/stock:manage/
  // stock:log_movement, must still see the real count and rows — proof
  // this feature is not accidentally gated the same way the last one was.
  it('includes lowStockItems for a viewer holding none of stock:read/stock:manage/stock:log_movement', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('POC_HOUSEKEEPING'));
    mockPrisma.unit.findMany.mockResolvedValue([]);
    mockPrisma.stockItem.findMany.mockResolvedValue([
      { id: 'stock_1', name: 'Dish Soap', category: 'KITCHEN', unitOfMeasure: 'bottle', currentQty: '2.00', reorderLevel: '5.00' },
    ]);

    const res = await request(createApp()).get('/api/v1/units/dashboard').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.kpi.lowStockItems).toBe(1);
    expect(res.body.lowStockItems).toHaveLength(1);
    expect(res.body.lowStockItems[0]).toMatchObject({ id: 'stock_1', name: 'Dish Soap', currentQty: 2, reorderLevel: 5 });
  });

  it('reports zero low-stock items when everything is at or above its reorder level', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('POC_HOUSEKEEPING'));
    mockPrisma.unit.findMany.mockResolvedValue([]);
    mockPrisma.stockItem.findMany.mockResolvedValue([
      { id: 'stock_1', name: 'Dish Soap', category: 'KITCHEN', unitOfMeasure: 'bottle', currentQty: '10.00', reorderLevel: '5.00' },
    ]);

    const res = await request(createApp()).get('/api/v1/units/dashboard').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.kpi.lowStockItems).toBe(0);
    expect(res.body.lowStockItems).toEqual([]);
  });
});

// The independent-gate case — held only for remittance:read, or only for
// quotation:read — has no real role to exercise it through: every role in
// the actual seed (rolePermissions.ts) that holds either key holds both.
// Rather than skip the case or fake a role that doesn't exist, this calls
// getUnitsDashboard directly with a hand-built permissions object, the
// same EffectivePermissions shape the router passes through from
// req.authUser.permissions — a true unit test of the gating logic itself,
// decoupled from what any current role happens to grant.
describe('getUnitsDashboard permission gating (direct)', () => {
  it('includes only the remittance fields when permissions hold remittance:read but not quotation:read', async () => {
    mockPrisma.unit.findMany.mockResolvedValue([]);
    mockPrisma.remittanceRequest.findMany.mockResolvedValue([
      { id: 'remit_1', referenceNo: 'RM-1', name: 'x', createdAt: new Date() },
    ]);

    const { getUnitsDashboard } = await import('../../../src/modules/units/service.js');
    const dashboard = await getUnitsDashboard({ 'remittance:read': 'ALL' });

    expect(dashboard.kpi.pendingRemittances).toBe(1);
    expect(dashboard.remittanceRequests).toHaveLength(1);
    expect(dashboard.kpi.pendingQuotations).toBeUndefined();
    expect(dashboard.quotationRequests).toBeUndefined();
    expect(mockPrisma.quotationRequest.findMany).not.toHaveBeenCalled();
  });

  it('includes only the quotation fields when permissions hold quotation:read but not remittance:read', async () => {
    mockPrisma.unit.findMany.mockResolvedValue([]);
    mockPrisma.quotationRequest.findMany.mockResolvedValue([
      { id: 'quote_1', referenceNo: 'QT-1', name: 'y', createdAt: new Date() },
    ]);

    const { getUnitsDashboard } = await import('../../../src/modules/units/service.js');
    const dashboard = await getUnitsDashboard({ 'quotation:read': 'ALL' });

    expect(dashboard.kpi.pendingQuotations).toBe(1);
    expect(dashboard.quotationRequests).toHaveLength(1);
    expect(dashboard.kpi.pendingRemittances).toBeUndefined();
    expect(dashboard.remittanceRequests).toBeUndefined();
    expect(mockPrisma.remittanceRequest.findMany).not.toHaveBeenCalled();
  });

  it('includes neither when permissions hold neither key', async () => {
    mockPrisma.unit.findMany.mockResolvedValue([]);

    const { getUnitsDashboard } = await import('../../../src/modules/units/service.js');
    const dashboard = await getUnitsDashboard({});

    expect(dashboard.kpi.pendingRemittances).toBeUndefined();
    expect(dashboard.kpi.pendingQuotations).toBeUndefined();
    expect(dashboard.remittanceRequests).toBeUndefined();
    expect(dashboard.quotationRequests).toBeUndefined();
  });
});

describe('GET /api/v1/units/activity', () => {
  it('requires unit:read', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESTAURANT_STAFF'));
    const res = await request(createApp()).get('/api/v1/units/activity').set('Cookie', authCookie());
    expect(res.status).toBe(403);
  });

  it('returns recent status-change events across all units, newest first', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.unitStatusEvent.findMany.mockResolvedValue([
      {
        id: 'event_2',
        unitId: 'unit_1',
        fromStatus: 'CLEANING',
        toStatus: 'CLEANED',
        note: null,
        createdAt: new Date('2026-08-23T10:00:00Z'),
        unit: { code: '101', name: 'Room 101' },
        actor: { fullName: 'Room Attendant 1 (Demo)' },
      },
    ]);

    const res = await request(createApp()).get('/api/v1/units/activity').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.events).toEqual([
      {
        id: 'event_2',
        unitId: 'unit_1',
        unitCode: '101',
        unitName: 'Room 101',
        fromStatus: 'CLEANING',
        toStatus: 'CLEANED',
        note: null,
        actorName: 'Room Attendant 1 (Demo)',
        createdAt: '2026-08-23T10:00:00.000Z',
      },
    ]);
    expect(mockPrisma.unitStatusEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 20 }),
    );
  });

  it('clamps an oversized limit query param to the max', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.unitStatusEvent.findMany.mockResolvedValue([]);

    const res = await request(createApp())
      .get('/api/v1/units/activity?limit=9999')
      .set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(mockPrisma.unitStatusEvent.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 50 }));
  });
});

describe('GET /api/v1/units/:id/timeline', () => {
  it('returns the unit status event history', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('POC_HOUSEKEEPING'));
    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnit());
    mockPrisma.unitStatusEvent.findMany.mockResolvedValue([
      { id: 'event_1', fromStatus: 'CLEANING', toStatus: 'CLEANED', createdAt: new Date(), note: null },
    ]);

    const res = await request(createApp()).get('/api/v1/units/unit_1/timeline').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
  });
});
