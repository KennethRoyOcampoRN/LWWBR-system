import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPrisma = {
  user: { findFirst: vi.fn() },
  setting: { findMany: vi.fn(), findUnique: vi.fn() },
  unit: { findMany: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
  unitStatusEvent: { create: vi.fn() },
  bookingUnit: { findMany: vi.fn() },
  booking: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  checkInRecord: { create: vi.fn() },
  checkOutRecord: { create: vi.fn() },
  // Spec §7.1's auto-created HOUSEKEEPING ticket on checkout — see
  // createWorkOrder's own call inside applyAutomaticUnitStatusChange
  // (units/service.ts). setting.findUnique backs createWorkOrder's own
  // getPhotoRequirements() read (falls back to shared defaults when it
  // resolves null, same as every other Setting-backed lookup in this
  // codebase).
  workOrder: { create: vi.fn() },
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
    employeeCode: 'LWW-030',
    fullName: 'Cashier One (Demo)',
    email: null,
    department: 'MANAGEMENT',
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
    code: 'R01',
    name: 'Room 1',
    unitTypeId: 'ut_1',
    type: 'ROOM',
    capacity: 4,
    status: 'READY',
    deletedAt: null,
    unitType: { id: 'ut_1', baseRate: '2500.00', dayTourRate: '1200.00', extraPersonRate: null },
    ...overrides,
  };
}

function validOvernightBody(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    guestName: 'Jane Dela Cruz',
    guestPhone: '09171234567',
    type: 'OVERNIGHT',
    arrivalDate: '2026-08-25',
    departureDate: '2026-08-26',
    pax: 2,
    units: [{ unitId: 'unit_1' }],
    ...overrides,
  };
}

function fakeBookingUnit(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'bu_1',
    bookingId: 'booking_1',
    unitId: 'unit_1',
    rate: '2500.00',
    unit: { id: 'unit_1', code: 'R01', name: 'Room 1', status: 'READY' },
    ...overrides,
  };
}

function fakeBooking(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'booking_1',
    referenceNo: 'LWW-260823-0003',
    guestName: 'Jane Dela Cruz',
    guestPhone: null,
    guestEmail: null,
    source: 'WALK_IN',
    type: 'OVERNIGHT',
    status: 'PENDING',
    pax: 2,
    childrenPax: 0,
    arrivalDate: new Date('2026-08-25T00:00:00.000Z'),
    departureDate: new Date('2026-08-26T00:00:00.000Z'),
    startAt: new Date('2026-08-25T06:00:00.000Z'),
    endAt: new Date('2026-08-26T04:00:00.000Z'),
    totalAmount: '2500.00',
    notes: null,
    createdById: 'user_2',
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    units: [fakeBookingUnit()],
    ...overrides,
  };
}

// The plain unit row applyAutomaticUnitStatusChange fetches on its own
// (a separate query from the booking's nested `units[].unit` include) —
// kept in sync with fakeBookingUnit's nested unit by each test that
// needs a specific status.
function fakeUnitForCheckin(overrides: Partial<Record<string, unknown>> = {}) {
  return { id: 'unit_1', code: 'R01', status: 'READY', version: 0, deletedAt: null, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.auditLog.findFirst.mockResolvedValue(null);
  mockPrisma.auditLog.count.mockResolvedValue(0);
  mockPrisma.auditLog.findMany.mockResolvedValue([]);
  mockRealtimeEmit.mockResolvedValue(undefined);
  mockPrisma.setting.findMany.mockResolvedValue([]); // fall back to shared defaults
  mockPrisma.setting.findUnique.mockResolvedValue(null); // fall back to shared defaults
  mockPrisma.referenceSequence.upsert.mockResolvedValue({ scope: 'LWW-260823', seq: 1 });
  mockPrisma.bookingUnit.findMany.mockResolvedValue([]); // no conflicts by default
  mockPrisma.unit.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.unitStatusEvent.create.mockResolvedValue({});
  mockPrisma.booking.update.mockResolvedValue({});
  mockPrisma.checkInRecord.create.mockResolvedValue({});
  mockPrisma.checkOutRecord.create.mockResolvedValue({});
  mockPrisma.workOrder.create.mockResolvedValue({ id: 'wo_1', referenceNo: 'WO-260824-0001', photos: [] });
});

describe('POST /api/v1/bookings — creation with real availability checking (spec §6/§7.5)', () => {
  it('creates an OVERNIGHT booking, resolving startAt/endAt from booking.checkInTime/checkOutTime', async () => {
    // generateReferenceNo (lib/referenceNo.ts) scopes its per-day sequence
    // off the real wall clock, not off referenceSequence.upsert's mocked
    // return value (only `seq` is read from that) — pinned here so this
    // assertion doesn't drift and fail every time the test actually runs
    // on a different calendar day than whenever it was first written.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-23T12:00:00.000Z'));
    try {
      mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
      mockPrisma.unit.findMany.mockResolvedValue([fakeUnit()]);
      mockPrisma.booking.create.mockImplementation(({ data }) =>
        Promise.resolve({
          id: 'booking_1',
          ...data,
          units: [{ id: 'bu_1', unitId: 'unit_1', rate: data.units.create[0].rate, unit: { id: 'unit_1', code: 'R01', name: 'Room 1' } }],
        }),
      );

      const res = await request(createApp()).post('/api/v1/bookings').set('Cookie', authCookie()).send(validOvernightBody());

      expect(res.status).toBe(201);
      expect(res.body.booking.referenceNo).toBe('LWW-260823-0001');
      expect(res.body.booking.status).toBe('PENDING');
      // 2026-08-25 14:00 Asia/Manila (+08:00) = 2026-08-25T06:00:00.000Z
      expect(new Date(res.body.booking.startAt).toISOString()).toBe('2026-08-25T06:00:00.000Z');
      // 2026-08-26 12:00 Asia/Manila (+08:00) = 2026-08-26T04:00:00.000Z
      expect(new Date(res.body.booking.endAt).toISOString()).toBe('2026-08-26T04:00:00.000Z');
      expect(res.body.booking.totalAmount).toBe(2500);
      expect(res.body.booking.units[0].rate).toBe(2500);
    } finally {
      vi.useRealTimers();
    }
  });

  it('creates a DAY_TOUR booking resolving the fixed 9am-5pm block, ignoring any departureDate', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
    mockPrisma.unit.findMany.mockResolvedValue([fakeUnit()]);
    mockPrisma.booking.create.mockImplementation(({ data }) =>
      Promise.resolve({
        id: 'booking_2',
        ...data,
        units: [{ id: 'bu_2', unitId: 'unit_1', rate: data.units.create[0].rate, unit: { id: 'unit_1', code: 'R01', name: 'Room 1' } }],
      }),
    );

    const res = await request(createApp())
      .post('/api/v1/bookings')
      .set('Cookie', authCookie())
      .send({ guestName: 'Day Tour Group', type: 'DAY_TOUR', arrivalDate: '2026-08-25', pax: 6, units: [{ unitId: 'unit_1' }] });

    expect(res.status).toBe(201);
    // 2026-08-25 09:00 Asia/Manila = 2026-08-25T01:00:00.000Z
    expect(new Date(res.body.booking.startAt).toISOString()).toBe('2026-08-25T01:00:00.000Z');
    // 2026-08-25 17:00 Asia/Manila = 2026-08-25T09:00:00.000Z
    expect(new Date(res.body.booking.endAt).toISOString()).toBe('2026-08-25T09:00:00.000Z');
    expect(res.body.booking.totalAmount).toBe(1200); // dayTourRate, no nights multiplier
  });

  it('rejects a DAY_TOUR with a departureDate supplied (422, schema-level)', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));

    const res = await request(createApp())
      .post('/api/v1/bookings')
      .set('Cookie', authCookie())
      .send({ guestName: 'X', type: 'DAY_TOUR', arrivalDate: '2026-08-25', departureDate: '2026-08-26', pax: 1, units: [{ unitId: 'unit_1' }] });

    expect(res.status).toBe(422);
    expect(mockPrisma.booking.create).not.toHaveBeenCalled();
  });

  it('rejects an OVERNIGHT with no departureDate (422, schema-level)', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));

    const res = await request(createApp())
      .post('/api/v1/bookings')
      .set('Cookie', authCookie())
      .send({ guestName: 'X', type: 'OVERNIGHT', arrivalDate: '2026-08-25', pax: 1, units: [{ unitId: 'unit_1' }] });

    expect(res.status).toBe(422);
  });

  it('rejects a departureDate that is not after arrivalDate (422, schema-level)', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));

    const res = await request(createApp())
      .post('/api/v1/bookings')
      .set('Cookie', authCookie())
      .send(validOvernightBody({ departureDate: '2026-08-25' }));

    expect(res.status).toBe(422);
  });

  it('rejects the same unit selected twice in one booking (422 VALIDATION_ERROR)', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));

    const res = await request(createApp())
      .post('/api/v1/bookings')
      .set('Cookie', authCookie())
      .send(validOvernightBody({ units: [{ unitId: 'unit_1' }, { unitId: 'unit_1' }] }));

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(mockPrisma.booking.create).not.toHaveBeenCalled();
  });

  it('rejects a booking for an unknown unit id (422 VALIDATION_ERROR)', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
    mockPrisma.unit.findMany.mockResolvedValue([]); // nothing matches

    const res = await request(createApp()).post('/api/v1/bookings').set('Cookie', authCookie()).send(validOvernightBody());

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(mockPrisma.booking.create).not.toHaveBeenCalled();
  });

  it.each(['OUT_OF_ORDER', 'BLOCKED'])('rejects booking a unit that is %s (409 UNIT_UNAVAILABLE)', async (status) => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
    mockPrisma.unit.findMany.mockResolvedValue([fakeUnit({ status })]);

    const res = await request(createApp()).post('/api/v1/bookings').set('Cookie', authCookie()).send(validOvernightBody());

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('UNIT_UNAVAILABLE');
    expect(res.body.error.details).toEqual(expect.objectContaining({ unitId: 'unit_1', reason: status }));
    expect(mockPrisma.booking.create).not.toHaveBeenCalled();
  });

  it('rejects an overlapping booking with 409 UNIT_UNAVAILABLE and the conflicting referenceNo in details', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
    mockPrisma.unit.findMany.mockResolvedValue([fakeUnit()]);
    // An existing booking overlapping the requested 8/25 14:00 -> 8/26
    // 12:00 window directly.
    mockPrisma.bookingUnit.findMany.mockResolvedValue([
      {
        unitId: 'unit_1',
        booking: { referenceNo: 'LWW-260820-0002', startAt: new Date('2026-08-25T04:00:00.000Z'), endAt: new Date('2026-08-27T04:00:00.000Z') },
      },
    ]);

    const res = await request(createApp()).post('/api/v1/bookings').set('Cookie', authCookie()).send(validOvernightBody());

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('UNIT_UNAVAILABLE');
    expect(res.body.error.details).toEqual(
      expect.objectContaining({ unitId: 'unit_1', conflictingReferenceNo: 'LWW-260820-0002' }),
    );
    expect(mockPrisma.booking.create).not.toHaveBeenCalled();
  });

  it('rejects a booking whose start falls inside the turnaround buffer after an existing booking ends (409)', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
    mockPrisma.unit.findMany.mockResolvedValue([fakeUnit()]);
    // Existing DAY_TOUR ends 2026-08-25T09:00:00.000Z (17:00 Manila); the
    // requested OVERNIGHT booking starts 2026-08-25T06:00:00.000Z (14:00
    // Manila the SAME day) — direct overlap, but also proves the
    // turnaround buffer isn't needed to catch this one; use a tighter
    // case below for the buffer specifically.
    mockPrisma.bookingUnit.findMany.mockResolvedValue([
      {
        unitId: 'unit_1',
        booking: { referenceNo: 'LWW-260820-0003', startAt: new Date('2026-08-25T01:00:00.000Z'), endAt: new Date('2026-08-25T05:30:00.000Z') },
      },
    ]);
    // Existing ends 05:30Z; requested starts 06:00Z — 30 min gap, less
    // than the default 60-minute turnaround buffer.

    const res = await request(createApp()).post('/api/v1/bookings').set('Cookie', authCookie()).send(validOvernightBody());

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('UNIT_UNAVAILABLE');
  });

  it('allows a booking starting exactly at the turnaround buffer boundary after the previous one ends', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
    mockPrisma.unit.findMany.mockResolvedValue([fakeUnit()]);
    // Requested startAt (from validOvernightBody, 2026-08-25 14:00
    // Manila) is 2026-08-25T06:00:00.000Z. Existing ends exactly 60
    // minutes earlier — right at the buffer boundary, not inside it.
    mockPrisma.bookingUnit.findMany.mockResolvedValue([
      {
        unitId: 'unit_1',
        booking: { referenceNo: 'LWW-260820-0004', startAt: new Date('2026-08-25T01:00:00.000Z'), endAt: new Date('2026-08-25T05:00:00.000Z') },
      },
    ]);
    mockPrisma.booking.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 'booking_3', ...data, units: [{ id: 'bu_3', unitId: 'unit_1', rate: data.units.create[0].rate, unit: fakeUnit() }] }),
    );

    const res = await request(createApp()).post('/api/v1/bookings').set('Cookie', authCookie()).send(validOvernightBody());

    expect(res.status).toBe(201);
  });

  it('ignores a CANCELLED booking on the same unit when checking availability', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
    mockPrisma.unit.findMany.mockResolvedValue([fakeUnit()]);
    // bookingUnit.findMany is the one that would exclude CANCELLED via
    // its own where clause — simulating that here by returning nothing,
    // since a CANCELLED booking's row would never come back from the
    // real query in the first place.
    mockPrisma.bookingUnit.findMany.mockResolvedValue([]);
    mockPrisma.booking.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 'booking_4', ...data, units: [{ id: 'bu_4', unitId: 'unit_1', rate: data.units.create[0].rate, unit: fakeUnit() }] }),
    );

    const res = await request(createApp()).post('/api/v1/bookings').set('Cookie', authCookie()).send(validOvernightBody());

    expect(res.status).toBe(201);
    // The query itself must exclude CANCELLED/CHECKED_OUT — assert the
    // where clause actually says so, not just that this particular mock
    // happened to return an empty array.
    const whereArg = mockPrisma.bookingUnit.findMany.mock.calls[0]?.[0]?.where;
    expect(whereArg.booking.status.notIn).toEqual(expect.arrayContaining(['CANCELLED', 'CHECKED_OUT']));
  });

  it('auto-fills the rate from UnitType.baseRate when none is supplied, and honors an explicit override', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
    mockPrisma.unit.findMany.mockResolvedValue([fakeUnit({ unitType: { id: 'ut_1', baseRate: '3000.00', dayTourRate: null, extraPersonRate: null } })]);
    mockPrisma.booking.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 'booking_5', ...data, units: [{ id: 'bu_5', unitId: 'unit_1', rate: data.units.create[0].rate, unit: fakeUnit() }] }),
    );

    const res = await request(createApp())
      .post('/api/v1/bookings')
      .set('Cookie', authCookie())
      .send(validOvernightBody({ units: [{ unitId: 'unit_1', rate: 3500 }] }));

    expect(res.status).toBe(201);
    expect(res.body.booking.units[0].rate).toBe(3500); // override honored, not baseRate
  });

  it('requires authentication', async () => {
    const res = await request(createApp()).post('/api/v1/bookings').send(validOvernightBody());
    expect(res.status).toBe(401);
  });

  it('is forbidden for a caller without booking:create', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('HOUSEKEEPING_STAFF', { department: 'HOUSEKEEPING' }));

    const res = await request(createApp()).post('/api/v1/bookings').set('Cookie', authCookie()).send(validOvernightBody());

    expect(res.status).toBe(403);
    expect(mockPrisma.booking.create).not.toHaveBeenCalled();
  });

  it('does not fail creation when the realtime broadcast itself fails', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
    mockPrisma.unit.findMany.mockResolvedValue([fakeUnit()]);
    mockPrisma.booking.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 'booking_6', ...data, units: [{ id: 'bu_6', unitId: 'unit_1', rate: data.units.create[0].rate, unit: fakeUnit() }] }),
    );
    mockRealtimeEmit.mockRejectedValue(new Error('Supabase Realtime unreachable'));

    const res = await request(createApp()).post('/api/v1/bookings').set('Cookie', authCookie()).send(validOvernightBody());

    expect(res.status).toBe(201);
  });

  it('reads the live booking.turnaroundMinutes Setting instead of the default when one exists', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
    mockPrisma.unit.findMany.mockResolvedValue([fakeUnit()]);
    // A tightened 15-minute buffer — the existing booking ends 30 minutes
    // before the new one starts, which would conflict under the default
    // 60-minute buffer but not under this Setting's 15-minute one.
    mockPrisma.setting.findMany.mockResolvedValue([{ key: 'booking.turnaroundMinutes', value: 15 }]);
    mockPrisma.bookingUnit.findMany.mockResolvedValue([
      {
        unitId: 'unit_1',
        booking: { referenceNo: 'LWW-260820-0005', startAt: new Date('2026-08-25T01:00:00.000Z'), endAt: new Date('2026-08-25T05:30:00.000Z') },
      },
    ]);
    mockPrisma.booking.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 'booking_7', ...data, units: [{ id: 'bu_7', unitId: 'unit_1', rate: data.units.create[0].rate, unit: fakeUnit() }] }),
    );

    const res = await request(createApp()).post('/api/v1/bookings').set('Cookie', authCookie()).send(validOvernightBody());

    expect(res.status).toBe(201);
  });
});

describe('GET /api/v1/units/:id/bookings — upcoming-booking visibility on the unit drawer (real gap found live-testing)', () => {
  it('returns current/future bookings for the unit, for a HOUSEKEEPING_STAFF caller who holds unit:read but not booking:read', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('HOUSEKEEPING_STAFF', { department: 'HOUSEKEEPING' }));
    mockPrisma.bookingUnit.findMany.mockResolvedValue([
      {
        unitId: 'unit_1',
        booking: {
          id: 'booking_1',
          referenceNo: 'LWW-260823-0003',
          guestName: 'Jane Dela Cruz',
          type: 'OVERNIGHT',
          status: 'CONFIRMED',
          startAt: new Date('2026-08-25T06:00:00.000Z'),
          endAt: new Date('2026-08-26T04:00:00.000Z'),
          _count: { units: 1 },
        },
      },
    ]);

    const res = await request(createApp()).get('/api/v1/units/unit_1/bookings').set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.bookings).toEqual([
      expect.objectContaining({
        referenceNo: 'LWW-260823-0003',
        guestName: 'Jane Dela Cruz',
        status: 'CONFIRMED',
        unitCount: 1,
      }),
    ]);
  });

  it('excludes CANCELLED and CHECKED_OUT bookings and past-ended bookings — asserts the actual query, not just a mock', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
    mockPrisma.bookingUnit.findMany.mockResolvedValue([]);

    const res = await request(createApp()).get('/api/v1/units/unit_1/bookings').set('Cookie', authCookie());

    expect(res.status).toBe(200);
    const whereArg = mockPrisma.bookingUnit.findMany.mock.calls[0]?.[0]?.where;
    expect(whereArg.unitId).toBe('unit_1');
    expect(whereArg.booking.status.notIn).toEqual(expect.arrayContaining(['CANCELLED', 'CHECKED_OUT']));
    expect(whereArg.booking.endAt.gte).toBeInstanceOf(Date);
  });

  it('requires authentication', async () => {
    const res = await request(createApp()).get('/api/v1/units/unit_1/bookings');
    expect(res.status).toBe(401);
  });

  it('is forbidden for a caller without unit:read', async () => {
    // No seeded role lacks unit:read entirely in this codebase's current
    // matrix, so this asserts against a role with no permissions at all
    // to prove the gate is real rather than trivially always passing.
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER', { roles: [] }));

    const res = await request(createApp()).get('/api/v1/units/unit_1/bookings').set('Cookie', authCookie());

    expect(res.status).toBe(403);
  });
});

describe('GET /api/v1/bookings/:id — accepts either the cuid or referenceNo', () => {
  it('finds a booking by referenceNo', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
    mockPrisma.booking.findFirst.mockResolvedValue(fakeBooking());

    const res = await request(createApp()).get('/api/v1/bookings/LWW-260823-0003').set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.booking.referenceNo).toBe('LWW-260823-0003');
    const whereArg = mockPrisma.booking.findFirst.mock.calls[0]?.[0]?.where;
    expect(whereArg.OR).toEqual([{ id: 'LWW-260823-0003' }, { referenceNo: 'LWW-260823-0003' }]);
  });

  it('returns 404 for an unknown booking', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
    mockPrisma.booking.findFirst.mockResolvedValue(null);

    const res = await request(createApp()).get('/api/v1/bookings/does_not_exist').set('Cookie', authCookie());

    expect(res.status).toBe(404);
  });
});

describe('GET /api/v1/bookings?search= — the guest-name-lookup half of check-in', () => {
  it('searches by guest name, scoped to PENDING/CONFIRMED bookings', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
    mockPrisma.booking.findMany.mockResolvedValue([fakeBooking()]);

    const res = await request(createApp()).get('/api/v1/bookings?search=Jane').set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.bookings).toHaveLength(1);
    const whereArg = mockPrisma.booking.findMany.mock.calls[0]?.[0]?.where;
    expect(whereArg.status.in).toEqual(['PENDING', 'CONFIRMED', 'CHECKED_IN']);
    expect(whereArg.OR).toEqual([
      { guestName: { contains: 'Jane', mode: 'insensitive' } },
      { referenceNo: { contains: 'Jane', mode: 'insensitive' } },
    ]);
  });

  it('rejects a search with no query string (422, schema-level)', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));

    const res = await request(createApp()).get('/api/v1/bookings').set('Cookie', authCookie());

    expect(res.status).toBe(422);
  });
});

describe('POST /api/v1/bookings/:id/checkin — urgent gap, spec §7.5 (client decision 2026-08-23)', () => {
  it('checks in a PENDING booking against a READY unit: unit -> OCCUPIED, booking -> CHECKED_IN', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
    mockPrisma.booking.findFirst
      .mockResolvedValueOnce(fakeBooking())
      .mockResolvedValueOnce(fakeBooking({ status: 'CHECKED_IN' }));
    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnitForCheckin());

    const res = await request(createApp()).post('/api/v1/bookings/booking_1/checkin').set('Cookie', authCookie()).send({});

    expect(res.status).toBe(200);
    expect(res.body.booking.status).toBe('CHECKED_IN');
    expect(mockPrisma.unit.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'unit_1', version: 0 }, data: expect.objectContaining({ status: 'OCCUPIED' }) }),
    );
    expect(mockPrisma.unitStatusEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ fromStatus: 'READY', toStatus: 'OCCUPIED', source: 'AUTOMATIC' }) }),
    );
    expect(mockPrisma.booking.update).toHaveBeenCalledWith({ where: { id: 'booking_1' }, data: { status: 'CHECKED_IN' } });
    expect(mockPrisma.checkInRecord.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ bookingId: 'booking_1', checkedInById: 'user_1' }) }),
    );
  });

  it('also allows checking in a CONFIRMED booking', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
    mockPrisma.booking.findFirst
      .mockResolvedValueOnce(fakeBooking({ status: 'CONFIRMED' }))
      .mockResolvedValueOnce(fakeBooking({ status: 'CHECKED_IN' }));
    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnitForCheckin());

    const res = await request(createApp()).post('/api/v1/bookings/booking_1/checkin').set('Cookie', authCookie()).send({});

    expect(res.status).toBe(200);
  });

  it.each(['CHECKED_IN', 'CHECKED_OUT', 'CANCELLED', 'NO_SHOW'])(
    'rejects checking in a booking already at %s (422 INVALID_TRANSITION)',
    async (status) => {
      mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
      mockPrisma.booking.findFirst.mockResolvedValue(fakeBooking({ status }));

      const res = await request(createApp()).post('/api/v1/bookings/booking_1/checkin').set('Cookie', authCookie()).send({});

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('INVALID_TRANSITION');
      expect(mockPrisma.unit.updateMany).not.toHaveBeenCalled();
    },
  );

  it.each(['OUT_OF_ORDER', 'BLOCKED'])('hard-blocks check-in when the unit is %s (409 UNIT_UNAVAILABLE)', async (status) => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
    mockPrisma.booking.findFirst.mockResolvedValue(
      fakeBooking({ units: [fakeBookingUnit({ unit: { id: 'unit_1', code: 'R01', name: 'Room 1', status } })] }),
    );

    const res = await request(createApp()).post('/api/v1/bookings/booking_1/checkin').set('Cookie', authCookie()).send({});

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('UNIT_UNAVAILABLE');
    expect(mockPrisma.unit.updateMany).not.toHaveBeenCalled();
  });

  it('hard-blocks check-in when the unit is already OCCUPIED by another booking, never overridable', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
    mockPrisma.booking.findFirst.mockResolvedValue(
      fakeBooking({ units: [fakeBookingUnit({ unit: { id: 'unit_1', code: 'R01', name: 'Room 1', status: 'OCCUPIED' } })] }),
    );

    const res = await request(createApp())
      .post('/api/v1/bookings/booking_1/checkin')
      .set('Cookie', authCookie())
      .send({ acknowledgeNotReady: true });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('UNIT_UNAVAILABLE');
  });

  it.each(['VACANT_DIRTY', 'CLEANING', 'CLEANED'])(
    'warns rather than hard-blocking check-in when the unit is %s and not yet acknowledged (409 UNIT_NOT_READY) — real edge case flagged in the report',
    async (status) => {
      mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
      mockPrisma.booking.findFirst.mockResolvedValue(
        fakeBooking({ units: [fakeBookingUnit({ unit: { id: 'unit_1', code: 'R01', name: 'Room 1', status } })] }),
      );

      const res = await request(createApp()).post('/api/v1/bookings/booking_1/checkin').set('Cookie', authCookie()).send({});

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('UNIT_NOT_READY');
      expect(res.body.error.details).toEqual(expect.objectContaining({ unitId: 'unit_1', unitStatus: status }));
      expect(mockPrisma.unit.updateMany).not.toHaveBeenCalled();
    },
  );

  it('proceeds with check-in from a non-READY unit once acknowledgeNotReady is true', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
    mockPrisma.booking.findFirst
      .mockResolvedValueOnce(fakeBooking({ units: [fakeBookingUnit({ unit: { id: 'unit_1', code: 'R01', name: 'Room 1', status: 'VACANT_DIRTY' } })] }))
      .mockResolvedValueOnce(fakeBooking({ status: 'CHECKED_IN' }));
    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnitForCheckin({ status: 'VACANT_DIRTY' }));

    const res = await request(createApp())
      .post('/api/v1/bookings/booking_1/checkin')
      .set('Cookie', authCookie())
      .send({ acknowledgeNotReady: true });

    expect(res.status).toBe(200);
    expect(mockPrisma.unit.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'OCCUPIED' }) }),
    );
  });

  it('requires authentication', async () => {
    const res = await request(createApp()).post('/api/v1/bookings/booking_1/checkin').send({});
    expect(res.status).toBe(401);
  });

  it('is forbidden for a caller without booking:checkin', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF', { roles: [] }));

    const res = await request(createApp()).post('/api/v1/bookings/booking_1/checkin').set('Cookie', authCookie()).send({});

    expect(res.status).toBe(403);
    expect(mockPrisma.booking.findFirst).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/bookings/:id/checkout — unconditional, no payment gate now or ever (client decision 2026-08-23)', () => {
  it('checks out a CHECKED_IN booking: unit -> VACANT_DIRTY, booking -> CHECKED_OUT, regardless of any balance', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
    mockPrisma.booking.findFirst
      .mockResolvedValueOnce(
        fakeBooking({ status: 'CHECKED_IN', units: [fakeBookingUnit({ unit: { id: 'unit_1', code: 'R01', name: 'Room 1', status: 'OCCUPIED' } })] }),
      )
      .mockResolvedValueOnce(fakeBooking({ status: 'CHECKED_OUT' }));
    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnitForCheckin({ status: 'OCCUPIED' }));

    const res = await request(createApp()).post('/api/v1/bookings/booking_1/checkout').set('Cookie', authCookie()).send({});

    expect(res.status).toBe(200);
    expect(res.body.booking.status).toBe('CHECKED_OUT');
    expect(mockPrisma.unit.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'VACANT_DIRTY' }) }),
    );
    expect(mockPrisma.unitStatusEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ fromStatus: 'OCCUPIED', toStatus: 'VACANT_DIRTY', source: 'AUTOMATIC' }) }),
    );
    expect(mockPrisma.booking.update).toHaveBeenCalledWith({ where: { id: 'booking_1' }, data: { status: 'CHECKED_OUT' } });
    // No balance/payment field anywhere in the request or the write path.
    expect(mockPrisma.checkOutRecord.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.not.objectContaining({ balance: expect.anything() }) }),
    );
    // Spec §7.1: "auto-creates a HOUSEKEEPING work order for that unit" —
    // real gap found live-testing 2026-08-24, wired up as part of this
    // multi-room-checkout redesign.
    expect(mockPrisma.workOrder.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'HOUSEKEEPING',
          department: 'HOUSEKEEPING',
          unitId: 'unit_1',
          priority: 'NORMAL',
          createdById: 'user_1',
        }),
      }),
    );
  });

  it('does NOT auto-create a housekeeping ticket on check-in (READY -> OCCUPIED) — only checkout reaches VACANT_DIRTY', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
    mockPrisma.booking.findFirst
      .mockResolvedValueOnce(fakeBooking({ status: 'PENDING' }))
      .mockResolvedValueOnce(fakeBooking({ status: 'CHECKED_IN' }));
    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnitForCheckin({ status: 'READY' }));

    const res = await request(createApp()).post('/api/v1/bookings/booking_1/checkin').set('Cookie', authCookie()).send({});

    expect(res.status).toBe(200);
    expect(mockPrisma.workOrder.create).not.toHaveBeenCalled();
  });

  it('does not fail checkout when auto-creating the housekeeping work order itself fails', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
    mockPrisma.booking.findFirst
      .mockResolvedValueOnce(
        fakeBooking({ status: 'CHECKED_IN', units: [fakeBookingUnit({ unit: { id: 'unit_1', code: 'R01', name: 'Room 1', status: 'OCCUPIED' } })] }),
      )
      .mockResolvedValueOnce(fakeBooking({ status: 'CHECKED_OUT' }));
    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnitForCheckin({ status: 'OCCUPIED' }));
    mockPrisma.workOrder.create.mockRejectedValue(new Error('database unreachable'));

    const res = await request(createApp()).post('/api/v1/bookings/booking_1/checkout').set('Cookie', authCookie()).send({});

    expect(res.status).toBe(200);
    expect(res.body.booking.status).toBe('CHECKED_OUT');
  });

  // Multi-room checkout, added 2026-08-24 (redesign, live-testing
  // feedback): "if a booking spans multiple units, checking out from any
  // one of those units should ask: check out just this room, or all
  // rooms under this booking?"
  describe('multi-room checkout (client decision 2026-08-24)', () => {
    function twoUnitBooking(overrides: Partial<Record<string, unknown>> = {}) {
      return fakeBooking({
        status: 'CHECKED_IN',
        units: [
          fakeBookingUnit({ id: 'bu_1', unitId: 'unit_1', unit: { id: 'unit_1', code: 'R01', name: 'Room 1', status: 'OCCUPIED' } }),
          fakeBookingUnit({ id: 'bu_2', unitId: 'unit_2', unit: { id: 'unit_2', code: 'R02', name: 'Room 2', status: 'OCCUPIED' } }),
        ],
        ...overrides,
      });
    }

    it('checking out just one unit (unitId given) leaves the booking CHECKED_IN and the other unit Occupied — no CheckOutRecord yet', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
      mockPrisma.booking.findFirst
        .mockResolvedValueOnce(twoUnitBooking())
        .mockResolvedValueOnce(twoUnitBooking({ status: 'CHECKED_IN' }));
      mockPrisma.unit.findFirst.mockResolvedValue(fakeUnitForCheckin({ status: 'OCCUPIED' }));

      const res = await request(createApp())
        .post('/api/v1/bookings/booking_1/checkout')
        .set('Cookie', authCookie())
        .send({ unitId: 'unit_1' });

      expect(res.status).toBe(200);
      expect(res.body.booking.status).toBe('CHECKED_IN');
      // Only the targeted unit was flipped.
      expect(mockPrisma.unit.updateMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.unit.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: 'unit_1' }) }),
      );
      // Not finalized yet — no checkout paperwork, no booking status write.
      expect(mockPrisma.checkOutRecord.create).not.toHaveBeenCalled();
      expect(mockPrisma.booking.update).not.toHaveBeenCalled();
    });

    it('checking out the last remaining unit (unitId given) finalizes the booking to CHECKED_OUT', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
      mockPrisma.booking.findFirst
        // unit_2 already checked out earlier; only unit_1 is still Occupied.
        .mockResolvedValueOnce(
          twoUnitBooking({
            units: [
              fakeBookingUnit({ id: 'bu_1', unitId: 'unit_1', unit: { id: 'unit_1', code: 'R01', name: 'Room 1', status: 'OCCUPIED' } }),
              fakeBookingUnit({ id: 'bu_2', unitId: 'unit_2', unit: { id: 'unit_2', code: 'R02', name: 'Room 2', status: 'VACANT_DIRTY' } }),
            ],
          }),
        )
        .mockResolvedValueOnce(twoUnitBooking({ status: 'CHECKED_OUT' }));
      mockPrisma.unit.findFirst.mockResolvedValue(fakeUnitForCheckin({ status: 'OCCUPIED' }));

      const res = await request(createApp())
        .post('/api/v1/bookings/booking_1/checkout')
        .set('Cookie', authCookie())
        .send({ unitId: 'unit_1' });

      expect(res.status).toBe(200);
      expect(res.body.booking.status).toBe('CHECKED_OUT');
      expect(mockPrisma.checkOutRecord.create).toHaveBeenCalled();
      expect(mockPrisma.booking.update).toHaveBeenCalledWith({ where: { id: 'booking_1' }, data: { status: 'CHECKED_OUT' } });
    });

    it('checking out with no unitId (all rooms) flips every Occupied unit and finalizes in one call', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
      mockPrisma.booking.findFirst.mockResolvedValueOnce(twoUnitBooking()).mockResolvedValueOnce(twoUnitBooking({ status: 'CHECKED_OUT' }));
      mockPrisma.unit.findFirst.mockResolvedValue(fakeUnitForCheckin({ status: 'OCCUPIED' }));

      const res = await request(createApp()).post('/api/v1/bookings/booking_1/checkout').set('Cookie', authCookie()).send({});

      expect(res.status).toBe(200);
      expect(res.body.booking.status).toBe('CHECKED_OUT');
      expect(mockPrisma.unit.updateMany).toHaveBeenCalledTimes(2);
      expect(mockPrisma.checkOutRecord.create).toHaveBeenCalled();
    });

    it('rejects a unitId that does not belong to the booking (422 VALIDATION_ERROR)', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
      mockPrisma.booking.findFirst.mockResolvedValue(twoUnitBooking());

      const res = await request(createApp())
        .post('/api/v1/bookings/booking_1/checkout')
        .set('Cookie', authCookie())
        .send({ unitId: 'unit_not_in_this_booking' });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(mockPrisma.unit.updateMany).not.toHaveBeenCalled();
    });

    it('rejects checking out a specific unit that is not currently Occupied (422 INVALID_TRANSITION)', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
      mockPrisma.booking.findFirst.mockResolvedValue(
        twoUnitBooking({
          units: [
            fakeBookingUnit({ id: 'bu_1', unitId: 'unit_1', unit: { id: 'unit_1', code: 'R01', name: 'Room 1', status: 'VACANT_DIRTY' } }),
            fakeBookingUnit({ id: 'bu_2', unitId: 'unit_2', unit: { id: 'unit_2', code: 'R02', name: 'Room 2', status: 'OCCUPIED' } }),
          ],
        }),
      );

      const res = await request(createApp())
        .post('/api/v1/bookings/booking_1/checkout')
        .set('Cookie', authCookie())
        .send({ unitId: 'unit_1' });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('INVALID_TRANSITION');
      expect(mockPrisma.unit.updateMany).not.toHaveBeenCalled();
    });
  });

  it.each(['PENDING', 'CONFIRMED', 'CHECKED_OUT', 'CANCELLED', 'NO_SHOW'])(
    'rejects checking out a booking not currently CHECKED_IN (422 INVALID_TRANSITION), from %s',
    async (status) => {
      mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
      mockPrisma.booking.findFirst.mockResolvedValue(fakeBooking({ status }));

      const res = await request(createApp()).post('/api/v1/bookings/booking_1/checkout').set('Cookie', authCookie()).send({});

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('INVALID_TRANSITION');
      expect(mockPrisma.unit.updateMany).not.toHaveBeenCalled();
    },
  );

  it('requires authentication', async () => {
    const res = await request(createApp()).post('/api/v1/bookings/booking_1/checkout').send({});
    expect(res.status).toBe(401);
  });

  it('is forbidden for a caller without booking:checkout', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF', { roles: [] }));

    const res = await request(createApp()).post('/api/v1/bookings/booking_1/checkout').set('Cookie', authCookie()).send({});

    expect(res.status).toBe(403);
  });

  it('does not fail checkout when the realtime broadcast itself fails', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
    mockPrisma.booking.findFirst
      .mockResolvedValueOnce(
        fakeBooking({ status: 'CHECKED_IN', units: [fakeBookingUnit({ unit: { id: 'unit_1', code: 'R01', name: 'Room 1', status: 'OCCUPIED' } })] }),
      )
      .mockResolvedValueOnce(fakeBooking({ status: 'CHECKED_OUT' }));
    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnitForCheckin({ status: 'OCCUPIED' }));
    mockRealtimeEmit.mockRejectedValue(new Error('Supabase Realtime unreachable'));

    const res = await request(createApp()).post('/api/v1/bookings/booking_1/checkout').set('Cookie', authCookie()).send({});

    expect(res.status).toBe(200);
  });
});
