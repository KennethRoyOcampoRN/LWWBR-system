import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPrisma = {
  user: { findFirst: vi.fn() },
  setting: { findMany: vi.fn() },
  unit: { findMany: vi.fn() },
  bookingUnit: { findMany: vi.fn() },
  booking: { create: vi.fn() },
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

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.auditLog.findFirst.mockResolvedValue(null);
  mockPrisma.auditLog.count.mockResolvedValue(0);
  mockPrisma.auditLog.findMany.mockResolvedValue([]);
  mockRealtimeEmit.mockResolvedValue(undefined);
  mockPrisma.setting.findMany.mockResolvedValue([]); // fall back to shared defaults
  mockPrisma.referenceSequence.upsert.mockResolvedValue({ scope: 'LWW-260823', seq: 1 });
  mockPrisma.bookingUnit.findMany.mockResolvedValue([]); // no conflicts by default
});

describe('POST /api/v1/bookings — creation with real availability checking (spec §6/§7.5)', () => {
  it('creates an OVERNIGHT booking, resolving startAt/endAt from booking.checkInTime/checkOutTime', async () => {
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
