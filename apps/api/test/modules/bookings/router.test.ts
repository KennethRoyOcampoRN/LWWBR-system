import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPrisma = {
  user: { findFirst: vi.fn() },
  setting: { findMany: vi.fn(), findUnique: vi.fn() },
  unit: { findMany: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
  unitStatusEvent: { create: vi.fn() },
  bookingUnit: { findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn(), create: vi.fn() },
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
  // generateReferenceNo (lib/referenceNo.ts) is still used by
  // createWorkOrder for the auto-created ticket's own WO- reference,
  // even though this module no longer generates its own booking
  // referenceNo (that's free-text from the client now).
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
    fullName: 'Admin Staff One (Demo)',
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
  return { id: 'unit_1', code: 'R01', name: 'Room 1', type: 'ROOM', status: 'READY', deletedAt: null, ...overrides };
}

function validCheckInBody(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    guestName: 'Jane Dela Cruz',
    externalBookingId: 'EXT-100',
    checkInDate: '2026-08-24',
    units: [{ unitId: 'unit_1' }],
    ...overrides,
  };
}

// The plain unit row applyAutomaticUnitStatusChange fetches on its own
// (a separate query from any booking-nested unit include) — kept in
// sync with each test's own unit status by whichever variant it needs.
function fakeUnitForTransition(overrides: Partial<Record<string, unknown>> = {}) {
  return { id: 'unit_1', code: 'R01', status: 'READY', version: 0, deletedAt: null, ...overrides };
}

// Builds a consistent "one Booking row with N units" shape — used both
// as the getBooking() response after check-in and as the checkout
// group's nested booking.units include, so a test only has to describe
// the units once and both call sites see the same data.
function fakeBookingWithUnits(
  overrides: Partial<Record<string, unknown>> = {},
  unitsSpec: { unitId: string; code: string; status: string }[] = [{ unitId: 'unit_1', code: 'R01', status: 'OCCUPIED' }],
) {
  const bookingId = (overrides.id as string) ?? 'booking_1';
  const units = unitsSpec.map((u, i) => ({
    id: `bu_${i}`,
    unitId: u.unitId,
    bookingId,
    rate: null,
    releasedAt: null,
    occupiedTo: null,
    unit: { id: u.unitId, code: u.code, name: `Room ${u.code}`, status: u.status, unitType: { name: 'Standard Room' } },
  }));
  return {
    id: bookingId,
    referenceNo: 'EXT-100',
    guestName: 'Jane Dela Cruz',
    status: 'CHECKED_IN',
    arrivalDate: new Date('2026-08-24T00:00:00.000Z'),
    departureDate: null,
    startAt: new Date('2026-08-24T09:00:00.000Z'),
    endAt: null,
    totalAmount: null,
    notes: null,
    createdById: 'user_1',
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    units,
    ...overrides,
  };
}

// One row as prisma.bookingUnit.findMany would return it for the
// checkout endpoint's own query — each row carries its own unit plus the
// *whole* owning booking (with that booking's full unit list nested), so
// checkOutUnits can decide per-booking whether every unit has cleared.
function bookingUnitRow(unitId: string, booking: ReturnType<typeof fakeBookingWithUnits>) {
  const bu = booking.units.find((u: { unitId: string }) => u.unitId === unitId);
  const unit = booking.units.find((u: { unitId: string }) => u.unitId === unitId)!.unit;
  return { ...bu, unit, booking };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.auditLog.findFirst.mockResolvedValue(null);
  mockPrisma.auditLog.count.mockResolvedValue(0);
  mockPrisma.auditLog.findMany.mockResolvedValue([]);
  mockRealtimeEmit.mockResolvedValue(undefined);
  mockPrisma.setting.findMany.mockResolvedValue([]);
  mockPrisma.setting.findUnique.mockResolvedValue(null);
  mockPrisma.referenceSequence.upsert.mockResolvedValue({ scope: 'WO-260824', seq: 1 });
  mockPrisma.unit.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.unitStatusEvent.create.mockResolvedValue({});
  mockPrisma.booking.update.mockResolvedValue({});
  mockPrisma.checkInRecord.create.mockResolvedValue({});
  mockPrisma.checkOutRecord.create.mockResolvedValue({});
  mockPrisma.workOrder.create.mockResolvedValue({ id: 'wo_1', referenceNo: 'WO-260824-0001', photos: [] });
});

describe('POST /api/v1/bookings/checkin — redesign 2026-08-24 (client decision): the only guest-arrival entry point', () => {
  it('creates a Booking directly at CHECKED_IN and moves the unit to OCCUPIED', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
    mockPrisma.unit.findMany.mockResolvedValue([fakeUnit()]);
    mockPrisma.booking.create.mockResolvedValue({ id: 'booking_1' });
    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnitForTransition());
    mockPrisma.booking.findFirst.mockResolvedValue(fakeBookingWithUnits());

    const res = await request(createApp()).post('/api/v1/bookings/checkin').set('Cookie', authCookie()).send(validCheckInBody());

    expect(res.status).toBe(201);
    expect(res.body.booking.status).toBe('CHECKED_IN');
    expect(mockPrisma.booking.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          referenceNo: 'EXT-100',
          guestName: 'Jane Dela Cruz',
          status: 'CHECKED_IN',
          createdById: 'user_1',
          units: { create: [{ unitId: 'unit_1' }] },
        }),
      }),
    );
    expect(mockPrisma.unit.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'unit_1', version: 0 }, data: expect.objectContaining({ status: 'OCCUPIED' }) }),
    );
    expect(mockPrisma.unitStatusEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ fromStatus: 'READY', toStatus: 'OCCUPIED', source: 'AUTOMATIC' }) }),
    );
    expect(mockPrisma.checkInRecord.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ bookingId: 'booking_1', checkedInById: 'user_1' }) }),
    );
    // No rate/pax/departureDate anywhere — Check-in never collects them.
    expect(mockPrisma.booking.create.mock.calls[0]?.[0]?.data).not.toHaveProperty('totalAmount');
    expect(mockPrisma.booking.create.mock.calls[0]?.[0]?.data).not.toHaveProperty('rate');
  });

  it('does not create a duplicate referenceNo constraint issue — the same external ID can be reused across separate check-ins', async () => {
    // Nothing in the schema enforces uniqueness anymore; this just
    // asserts the create call never references a uniqueness check or a
    // generated referenceNo — it's the raw externalBookingId, verbatim.
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
    mockPrisma.unit.findMany.mockResolvedValue([fakeUnit()]);
    mockPrisma.booking.create.mockResolvedValue({ id: 'booking_2' });
    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnitForTransition());
    mockPrisma.booking.findFirst.mockResolvedValue(fakeBookingWithUnits({ id: 'booking_2' }));

    const res = await request(createApp())
      .post('/api/v1/bookings/checkin')
      .set('Cookie', authCookie())
      .send(validCheckInBody({ externalBookingId: 'EXT-100' }));

    expect(res.status).toBe(201);
    expect(mockPrisma.booking.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ referenceNo: 'EXT-100' }) }),
    );
  });

  it('checks in more than one room in a single submission', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
    mockPrisma.unit.findMany.mockResolvedValue([fakeUnit(), fakeUnit({ id: 'unit_2', code: 'R02' })]);
    mockPrisma.booking.create.mockResolvedValue({ id: 'booking_1' });
    mockPrisma.unit.findFirst.mockImplementation(({ where }: { where: { id: string } }) =>
      Promise.resolve(fakeUnitForTransition({ id: where.id })),
    );
    mockPrisma.booking.findFirst.mockResolvedValue(
      fakeBookingWithUnits({}, [
        { unitId: 'unit_1', code: 'R01', status: 'OCCUPIED' },
        { unitId: 'unit_2', code: 'R02', status: 'OCCUPIED' },
      ]),
    );

    const res = await request(createApp())
      .post('/api/v1/bookings/checkin')
      .set('Cookie', authCookie())
      .send(validCheckInBody({ units: [{ unitId: 'unit_1' }, { unitId: 'unit_2' }] }));

    expect(res.status).toBe(201);
    expect(mockPrisma.unit.updateMany).toHaveBeenCalledTimes(2);
  });

  it('rejects the same unit selected twice (422 VALIDATION_ERROR)', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));

    const res = await request(createApp())
      .post('/api/v1/bookings/checkin')
      .set('Cookie', authCookie())
      .send(validCheckInBody({ units: [{ unitId: 'unit_1' }, { unitId: 'unit_1' }] }));

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(mockPrisma.booking.create).not.toHaveBeenCalled();
  });

  it('rejects an unknown unit id (422 VALIDATION_ERROR)', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
    mockPrisma.unit.findMany.mockResolvedValue([]);

    const res = await request(createApp()).post('/api/v1/bookings/checkin').set('Cookie', authCookie()).send(validCheckInBody());

    expect(res.status).toBe(422);
    expect(mockPrisma.booking.create).not.toHaveBeenCalled();
  });

  // Real bug found live-testing, 2026-08-25: common areas (Beach Front,
  // CR-Female/Male, Function Hall, Pool, Restaurant — COMMON_AREA/
  // FACILITY) were checkable-into alongside real guest accommodations.
  // The picker now filters these out client-side; this is the real
  // server-side block.
  it.each(['COMMON_AREA', 'FACILITY'])('rejects check-in for a %s unit (422 UNIT_NOT_BOOKABLE)', async (type) => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
    mockPrisma.unit.findMany.mockResolvedValue([fakeUnit({ type })]);

    const res = await request(createApp()).post('/api/v1/bookings/checkin').set('Cookie', authCookie()).send(validCheckInBody());

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('UNIT_NOT_BOOKABLE');
    expect(mockPrisma.booking.create).not.toHaveBeenCalled();
  });

  it.each(['ROOM', 'COTTAGE'])('allows check-in for a %s unit to proceed past the type guard', async (type) => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
    mockPrisma.unit.findMany.mockResolvedValue([fakeUnit({ type, status: 'READY' })]);
    mockPrisma.booking.create.mockResolvedValue({ id: 'booking_1' });
    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnitForTransition());
    mockPrisma.booking.findFirst.mockResolvedValue(fakeBookingWithUnits());

    const res = await request(createApp()).post('/api/v1/bookings/checkin').set('Cookie', authCookie()).send(validCheckInBody());

    expect(res.status).toBe(201);
    expect(mockPrisma.booking.create).toHaveBeenCalled();
  });

  it.each(['OUT_OF_ORDER', 'BLOCKED'])('hard-blocks check-in when the unit is %s (409 UNIT_UNAVAILABLE)', async (status) => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
    mockPrisma.unit.findMany.mockResolvedValue([fakeUnit({ status })]);

    const res = await request(createApp()).post('/api/v1/bookings/checkin').set('Cookie', authCookie()).send(validCheckInBody());

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('UNIT_UNAVAILABLE');
    expect(mockPrisma.booking.create).not.toHaveBeenCalled();
  });

  it('hard-blocks check-in when the unit is already OCCUPIED, never overridable', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
    mockPrisma.unit.findMany.mockResolvedValue([fakeUnit({ status: 'OCCUPIED' })]);

    const res = await request(createApp())
      .post('/api/v1/bookings/checkin')
      .set('Cookie', authCookie())
      .send(validCheckInBody({ acknowledgeNotReady: true }));

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('UNIT_UNAVAILABLE');
    expect(mockPrisma.booking.create).not.toHaveBeenCalled();
  });

  it.each(['VACANT_DIRTY', 'CLEANING', 'CLEANED'])(
    'warns rather than hard-blocking when the unit is %s and not yet acknowledged (409 UNIT_NOT_READY)',
    async (status) => {
      mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
      mockPrisma.unit.findMany.mockResolvedValue([fakeUnit({ status })]);

      const res = await request(createApp()).post('/api/v1/bookings/checkin').set('Cookie', authCookie()).send(validCheckInBody());

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('UNIT_NOT_READY');
      expect(res.body.error.details).toEqual(expect.objectContaining({ unitId: 'unit_1', unitStatus: status }));
      expect(mockPrisma.booking.create).not.toHaveBeenCalled();
    },
  );

  it('proceeds with check-in from a non-READY unit once acknowledgeNotReady is true', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
    mockPrisma.unit.findMany.mockResolvedValue([fakeUnit({ status: 'VACANT_DIRTY' })]);
    mockPrisma.booking.create.mockResolvedValue({ id: 'booking_1' });
    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnitForTransition({ status: 'VACANT_DIRTY' }));
    mockPrisma.booking.findFirst.mockResolvedValue(fakeBookingWithUnits());

    const res = await request(createApp())
      .post('/api/v1/bookings/checkin')
      .set('Cookie', authCookie())
      .send(validCheckInBody({ acknowledgeNotReady: true }));

    expect(res.status).toBe(201);
    expect(mockPrisma.unit.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'OCCUPIED' }) }),
    );
  });

  it('does not auto-create a housekeeping ticket on check-in — only checkout reaches VACANT_DIRTY', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
    mockPrisma.unit.findMany.mockResolvedValue([fakeUnit()]);
    mockPrisma.booking.create.mockResolvedValue({ id: 'booking_1' });
    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnitForTransition());
    mockPrisma.booking.findFirst.mockResolvedValue(fakeBookingWithUnits());

    const res = await request(createApp()).post('/api/v1/bookings/checkin').set('Cookie', authCookie()).send(validCheckInBody());

    expect(res.status).toBe(201);
    expect(mockPrisma.workOrder.create).not.toHaveBeenCalled();
  });

  it('requires authentication', async () => {
    const res = await request(createApp()).post('/api/v1/bookings/checkin').send(validCheckInBody());
    expect(res.status).toBe(401);
  });

  it('is forbidden for a caller without booking:checkin', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF', { roles: [] }));

    const res = await request(createApp()).post('/api/v1/bookings/checkin').set('Cookie', authCookie()).send(validCheckInBody());

    expect(res.status).toBe(403);
    expect(mockPrisma.booking.create).not.toHaveBeenCalled();
  });

  it('does not fail check-in when the realtime broadcast itself fails', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
    mockPrisma.unit.findMany.mockResolvedValue([fakeUnit()]);
    mockPrisma.booking.create.mockResolvedValue({ id: 'booking_1' });
    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnitForTransition());
    mockPrisma.booking.findFirst.mockResolvedValue(fakeBookingWithUnits());
    mockRealtimeEmit.mockRejectedValue(new Error('Supabase Realtime unreachable'));

    const res = await request(createApp()).post('/api/v1/bookings/checkin').set('Cookie', authCookie()).send(validCheckInBody());

    expect(res.status).toBe(201);
  });
});

describe('GET /api/v1/bookings/group — the checkout checklist, redesign 2026-08-24', () => {
  it('returns every currently-Occupied unit sharing the referenceNo of a CHECKED_IN booking', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
    mockPrisma.bookingUnit.findMany.mockResolvedValue([
      {
        unit: { id: 'unit_1', code: 'R01', name: 'Room 1', status: 'OCCUPIED' },
        booking: { id: 'booking_1', guestName: 'Jane Dela Cruz' },
      },
      {
        unit: { id: 'unit_2', code: 'R02', name: 'Room 2', status: 'OCCUPIED' },
        booking: { id: 'booking_2', guestName: 'Jane Dela Cruz' },
      },
    ]);

    const res = await request(createApp()).get('/api/v1/bookings/group?referenceNo=EXT-100').set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.units).toEqual([
      { unitId: 'unit_1', code: 'R01', name: 'Room 1', bookingId: 'booking_1', guestName: 'Jane Dela Cruz' },
      { unitId: 'unit_2', code: 'R02', name: 'Room 2', bookingId: 'booking_2', guestName: 'Jane Dela Cruz' },
    ]);
    const whereArg = mockPrisma.bookingUnit.findMany.mock.calls[0]?.[0]?.where;
    expect(whereArg.booking.referenceNo).toBe('EXT-100');
    // Real gap found live-testing, 2026-08-24: was `status: 'CHECKED_IN'`
    // — too strict for a legacy booking whose own transition never
    // completed before the old check-in flow was removed. Only the two
    // genuinely-closed statuses are excluded now; Unit.status is the
    // real signal (asserted separately below).
    expect(whereArg.booking.status.notIn).toEqual(expect.arrayContaining(['CANCELLED', 'CHECKED_OUT']));
    expect(whereArg.unit.status).toBe('OCCUPIED');
    // Added in review, 2026-11-05 (spec.md §13 decision 16), alongside
    // the same gap found elsewhere: without this, a unit moved away
    // from and later re-added to the same referenceNo group would list
    // twice, once per BookingUnit row.
    expect(whereArg.releasedAt).toBeNull();
  });

  it('requires authentication', async () => {
    const res = await request(createApp()).get('/api/v1/bookings/group?referenceNo=EXT-100');
    expect(res.status).toBe(401);
  });

  it('is forbidden for a caller without booking:checkout', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF', { roles: [] }));

    const res = await request(createApp()).get('/api/v1/bookings/group?referenceNo=EXT-100').set('Cookie', authCookie());

    expect(res.status).toBe(403);
  });
});

describe('POST /api/v1/bookings/checkout — checklist-based, redesign 2026-08-24 (client decision)', () => {
  it('checks out a single-unit booking: unit -> VACANT_DIRTY, booking finalized, HOUSEKEEPING ticket created', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
    const booking = fakeBookingWithUnits();
    mockPrisma.bookingUnit.findMany.mockResolvedValue([bookingUnitRow('unit_1', booking)]);
    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnitForTransition({ status: 'OCCUPIED' }));

    const res = await request(createApp()).post('/api/v1/bookings/checkout').set('Cookie', authCookie()).send({ unitIds: ['unit_1'] });

    expect(res.status).toBe(200);
    expect(res.body.finalizedBookingIds).toEqual(['booking_1']);
    expect(res.body.checkedOutUnitIds).toEqual(['unit_1']);
    expect(mockPrisma.unit.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'VACANT_DIRTY' }) }),
    );
    expect(mockPrisma.unitStatusEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ fromStatus: 'OCCUPIED', toStatus: 'VACANT_DIRTY', source: 'AUTOMATIC' }) }),
    );
    expect(mockPrisma.checkOutRecord.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ bookingId: 'booking_1', checkedOutById: 'user_1' }) }),
    );
    // No balance/payment field anywhere in the write path.
    expect(mockPrisma.checkOutRecord.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.not.objectContaining({ balance: expect.anything() }) }),
    );
    expect(mockPrisma.booking.update).toHaveBeenCalledWith({
      where: { id: 'booking_1' },
      data: expect.objectContaining({ status: 'CHECKED_OUT', endAt: expect.any(Date) }),
    });
    // Spec §7.1: "auto-creates a HOUSEKEEPING work order for that unit."
    expect(mockPrisma.workOrder.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: 'HOUSEKEEPING', department: 'HOUSEKEEPING', unitId: 'unit_1', priority: 'NORMAL' }),
      }),
    );
  });

  // Bug caught in review, 2026-11-05 (spec.md §13 decision 16): without
  // releasedAt: null, a unitId moved away from one booking into another
  // (moveBookingUnit) still matches its old, released row here too,
  // which could pull a booking that no longer holds this unit into the
  // checkout call's own validation and grouping. Same filter needed on
  // the nested booking.units include, which the per-booking "is every
  // unit clear" check reads — a released row there could easily still
  // read Unit.status OCCUPIED, just under someone else's booking now.
  it('queries both the requested units and each booking\'s own unit list by releasedAt: null', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
    const booking = fakeBookingWithUnits();
    mockPrisma.bookingUnit.findMany.mockResolvedValue([bookingUnitRow('unit_1', booking)]);
    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnitForTransition({ status: 'OCCUPIED' }));

    await request(createApp()).post('/api/v1/bookings/checkout').set('Cookie', authCookie()).send({ unitIds: ['unit_1'] });

    const call = mockPrisma.bookingUnit.findMany.mock.calls[0]?.[0];
    expect(call.where).toEqual(expect.objectContaining({ releasedAt: null }));
    expect(call.include.booking.include.units.where).toEqual({ releasedAt: null });
  });

  it('checking out just one unit of a multi-unit booking leaves it CHECKED_IN — no CheckOutRecord yet', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
    const booking = fakeBookingWithUnits({}, [
      { unitId: 'unit_1', code: 'R01', status: 'OCCUPIED' },
      { unitId: 'unit_2', code: 'R02', status: 'OCCUPIED' },
    ]);
    mockPrisma.bookingUnit.findMany.mockResolvedValue([bookingUnitRow('unit_1', booking)]);
    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnitForTransition({ status: 'OCCUPIED' }));

    const res = await request(createApp()).post('/api/v1/bookings/checkout').set('Cookie', authCookie()).send({ unitIds: ['unit_1'] });

    expect(res.status).toBe(200);
    expect(res.body.finalizedBookingIds).toEqual([]);
    expect(mockPrisma.unit.updateMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.checkOutRecord.create).not.toHaveBeenCalled();
    expect(mockPrisma.booking.update).not.toHaveBeenCalled();
  });

  // Client's own scenario, caught live-testing (spec.md §13 decision
  // 16): a guest with three rooms releases one two nights early. The
  // booking must stay CHECKED_IN (confirmed by the previous test), but
  // this pins the actual bug found in review — the released room's own
  // BookingUnit row must close on both fields (releasedAt so it stops
  // reading as held, occupiedTo so a later ROOM charge prices the
  // nights actually stayed, not the full original plan), while the
  // other two rooms' rows are untouched.
  it("three-room booking, one checked out early: that room's row closes on both fields, the other two are untouched", async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
    const booking = fakeBookingWithUnits({}, [
      { unitId: 'unit_1', code: 'R01', status: 'OCCUPIED' },
      { unitId: 'unit_2', code: 'R02', status: 'OCCUPIED' },
      { unitId: 'unit_3', code: 'R03', status: 'OCCUPIED' },
    ]);
    mockPrisma.bookingUnit.findMany.mockResolvedValue([bookingUnitRow('unit_1', booking)]);
    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnitForTransition({ status: 'OCCUPIED' }));
    mockPrisma.bookingUnit.update.mockResolvedValue({});

    const res = await request(createApp()).post('/api/v1/bookings/checkout').set('Cookie', authCookie()).send({ unitIds: ['unit_1'] });

    expect(res.status).toBe(200);
    // Booking stays CHECKED_IN — two rooms are still Occupied.
    expect(res.body.finalizedBookingIds).toEqual([]);
    expect(mockPrisma.booking.update).not.toHaveBeenCalled();
    // Only unit_1's own row (bu_0) closes, on both fields.
    expect(mockPrisma.bookingUnit.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.bookingUnit.update).toHaveBeenCalledWith({
      where: { id: 'bu_0' },
      data: { releasedAt: expect.any(Date), occupiedTo: expect.any(Date) },
    });
  });

  it('checking out both units of a multi-unit booking together finalizes it in one call', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
    const booking = fakeBookingWithUnits({}, [
      { unitId: 'unit_1', code: 'R01', status: 'OCCUPIED' },
      { unitId: 'unit_2', code: 'R02', status: 'OCCUPIED' },
    ]);
    mockPrisma.bookingUnit.findMany.mockResolvedValue([bookingUnitRow('unit_1', booking), bookingUnitRow('unit_2', booking)]);
    mockPrisma.unit.findFirst.mockImplementation(({ where }: { where: { id: string } }) =>
      Promise.resolve(fakeUnitForTransition({ id: where.id, status: 'OCCUPIED' })),
    );

    const res = await request(createApp())
      .post('/api/v1/bookings/checkout')
      .set('Cookie', authCookie())
      .send({ unitIds: ['unit_1', 'unit_2'] });

    expect(res.status).toBe(200);
    expect(res.body.finalizedBookingIds).toEqual(['booking_1']);
    expect(mockPrisma.unit.updateMany).toHaveBeenCalledTimes(2);
    expect(mockPrisma.checkOutRecord.create).toHaveBeenCalledTimes(1);
  });

  it('a checkout call spanning two different Booking rows (a group checked in across waves) finalizes each independently', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
    const bookingA = fakeBookingWithUnits({ id: 'booking_a' }, [{ unitId: 'unit_1', code: 'R01', status: 'OCCUPIED' }]);
    const bookingB = fakeBookingWithUnits({ id: 'booking_b' }, [
      { unitId: 'unit_2', code: 'R02', status: 'OCCUPIED' },
      { unitId: 'unit_3', code: 'R03', status: 'OCCUPIED' },
    ]);
    mockPrisma.bookingUnit.findMany.mockResolvedValue([
      bookingUnitRow('unit_1', bookingA),
      bookingUnitRow('unit_2', bookingB),
      // unit_3 (also under booking_b) is NOT part of this checkout call.
    ]);
    mockPrisma.unit.findFirst.mockImplementation(({ where }: { where: { id: string } }) =>
      Promise.resolve(fakeUnitForTransition({ id: where.id, status: 'OCCUPIED' })),
    );

    const res = await request(createApp())
      .post('/api/v1/bookings/checkout')
      .set('Cookie', authCookie())
      .send({ unitIds: ['unit_1', 'unit_2'] });

    expect(res.status).toBe(200);
    // booking_a fully clears (its only unit); booking_b does not (unit_3
    // is still Occupied and wasn't part of this call).
    expect(res.body.finalizedBookingIds).toEqual(['booking_a']);
    expect(mockPrisma.checkOutRecord.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.checkOutRecord.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ bookingId: 'booking_a' }) }),
    );
  });

  it('rejects a unitId that is not part of any active booking (422 VALIDATION_ERROR)', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
    mockPrisma.bookingUnit.findMany.mockResolvedValue([]);

    const res = await request(createApp())
      .post('/api/v1/bookings/checkout')
      .set('Cookie', authCookie())
      .send({ unitIds: ['unit_not_active'] });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(mockPrisma.unit.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a unit that is not currently Occupied (422 INVALID_TRANSITION)', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
    const booking = fakeBookingWithUnits({}, [{ unitId: 'unit_1', code: 'R01', status: 'VACANT_DIRTY' }]);
    mockPrisma.bookingUnit.findMany.mockResolvedValue([bookingUnitRow('unit_1', booking)]);

    const res = await request(createApp()).post('/api/v1/bookings/checkout').set('Cookie', authCookie()).send({ unitIds: ['unit_1'] });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVALID_TRANSITION');
    expect(mockPrisma.unit.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a unit whose booking is already closed out (CHECKED_OUT), even if the unit itself is still Occupied (422 INVALID_TRANSITION)', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
    const booking = fakeBookingWithUnits({ status: 'CHECKED_OUT' });
    mockPrisma.bookingUnit.findMany.mockResolvedValue([bookingUnitRow('unit_1', booking)]);

    const res = await request(createApp()).post('/api/v1/bookings/checkout').set('Cookie', authCookie()).send({ unitIds: ['unit_1'] });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVALID_TRANSITION');
    expect(mockPrisma.unit.updateMany).not.toHaveBeenCalled();
  });

  // Re-tightened 2026-11-05 (spec.md §13 decision 16): this briefly
  // allowed checkout for *any* non-CANCELLED/CHECKED_OUT booking
  // (2026-08-24), specifically to unstick a legacy PENDING/CONFIRMED
  // booking that had no forward path at all back then. That's no longer
  // true for CONFIRMED — it now has real forward edges
  // (resolveConfirmedBooking) — so a CONFIRMED (pre-arrival) booking
  // must be routed through one of those, not checked out through this
  // endpoint directly. PENDING stays legacy/unreachable either way; a
  // genuinely stuck pre-redesign row needs a force status correction
  // (the SYSTEM_ADMIN override), not this checklist.
  it.each(['PENDING', 'CONFIRMED'])(
    'rejects checkout for a unit whose booking is %s, even if the unit itself is Occupied (422 INVALID_TRANSITION)',
    async (status) => {
      mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_HEAD'));
      const booking = fakeBookingWithUnits({ status });
      mockPrisma.bookingUnit.findMany.mockResolvedValue([bookingUnitRow('unit_1', booking)]);
      mockPrisma.unit.findFirst.mockResolvedValue(fakeUnitForTransition({ status: 'OCCUPIED' }));

      const res = await request(createApp()).post('/api/v1/bookings/checkout').set('Cookie', authCookie()).send({ unitIds: ['unit_1'] });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('INVALID_TRANSITION');
      expect(mockPrisma.unit.updateMany).not.toHaveBeenCalled();
      expect(mockPrisma.booking.update).not.toHaveBeenCalled();
    },
  );

  it('does not fail checkout when auto-creating the housekeeping work order itself fails', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
    const booking = fakeBookingWithUnits();
    mockPrisma.bookingUnit.findMany.mockResolvedValue([bookingUnitRow('unit_1', booking)]);
    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnitForTransition({ status: 'OCCUPIED' }));
    mockPrisma.workOrder.create.mockRejectedValue(new Error('database unreachable'));

    const res = await request(createApp()).post('/api/v1/bookings/checkout').set('Cookie', authCookie()).send({ unitIds: ['unit_1'] });

    expect(res.status).toBe(200);
    expect(res.body.finalizedBookingIds).toEqual(['booking_1']);
  });

  it('does not fail checkout when the realtime broadcast itself fails', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
    const booking = fakeBookingWithUnits();
    mockPrisma.bookingUnit.findMany.mockResolvedValue([bookingUnitRow('unit_1', booking)]);
    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnitForTransition({ status: 'OCCUPIED' }));
    mockRealtimeEmit.mockRejectedValue(new Error('Supabase Realtime unreachable'));

    const res = await request(createApp()).post('/api/v1/bookings/checkout').set('Cookie', authCookie()).send({ unitIds: ['unit_1'] });

    expect(res.status).toBe(200);
  });

  it('requires authentication', async () => {
    const res = await request(createApp()).post('/api/v1/bookings/checkout').send({ unitIds: ['unit_1'] });
    expect(res.status).toBe(401);
  });

  it('is forbidden for a caller without booking:checkout', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF', { roles: [] }));

    const res = await request(createApp()).post('/api/v1/bookings/checkout').set('Cookie', authCookie()).send({ unitIds: ['unit_1'] });

    expect(res.status).toBe(403);
  });

  it('rejects an empty unitIds array (422, schema-level)', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));

    const res = await request(createApp()).post('/api/v1/bookings/checkout').set('Cookie', authCookie()).send({ unitIds: [] });

    expect(res.status).toBe(422);
  });
});

describe('GET /api/v1/units/:id/bookings — upcoming-booking visibility on the unit drawer', () => {
  it('returns current bookings for the unit, for a HOUSEKEEPING_STAFF caller who holds unit:read but not booking:checkin/checkout', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('HOUSEKEEPING_STAFF', { department: 'HOUSEKEEPING' }));
    mockPrisma.bookingUnit.findMany.mockResolvedValue([
      {
        unitId: 'unit_1',
        booking: {
          id: 'booking_1',
          referenceNo: 'EXT-100',
          guestName: 'Jane Dela Cruz',
          type: 'OVERNIGHT',
          status: 'CHECKED_IN',
          startAt: new Date('2026-08-24T06:00:00.000Z'),
          endAt: null,
        },
      },
    ]);

    const res = await request(createApp()).get('/api/v1/units/unit_1/bookings').set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.bookings).toEqual([
      expect.objectContaining({ referenceNo: 'EXT-100', guestName: 'Jane Dela Cruz', status: 'CHECKED_IN' }),
    ]);
  });

  it('includes an open-ended (null endAt) booking, and excludes CANCELLED/CHECKED_OUT — asserts the actual query', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
    mockPrisma.bookingUnit.findMany.mockResolvedValue([]);

    const res = await request(createApp()).get('/api/v1/units/unit_1/bookings').set('Cookie', authCookie());

    expect(res.status).toBe(200);
    const whereArg = mockPrisma.bookingUnit.findMany.mock.calls[0]?.[0]?.where;
    expect(whereArg.unitId).toBe('unit_1');
    expect(whereArg.booking.status.notIn).toEqual(expect.arrayContaining(['CANCELLED', 'CHECKED_OUT']));
    // Redesign, 2026-08-24, twice over — see this function's own
    // comment. Must include `endAt: null` (an open-ended, currently-
    // occupied stay), not just `endAt >= now` — a plain `gte` filter
    // alone would silently drop every current guest with no known
    // departure. `unit: { status: 'OCCUPIED' }` (not `booking.status ===
    // 'CHECKED_IN'` — a first attempt that still failed for a booking
    // stuck at a legacy status) covers the other real gap: a
    // pre-redesign booking's real, non-null endAt that has since passed
    // while the room itself is still genuinely Occupied.
    expect(whereArg.OR).toEqual(
      expect.arrayContaining([
        { unit: { status: 'OCCUPIED' } },
        { booking: { endAt: null } },
        expect.objectContaining({ booking: expect.objectContaining({ endAt: expect.objectContaining({ gte: expect.any(Date) }) }) }),
      ]),
    );
    // Added in review, 2026-11-05 (spec.md §13 decision 16): without
    // this, a BookingUnit row this unit was moved away from could still
    // match — its booking isn't excluded and the unit's own current
    // status is OCCUPIED, just under whoever has it now — showing the
    // drawer a stale booking instead of the real current occupant.
    expect(whereArg.releasedAt).toBeNull();
  });

  // Real gap found live-testing, 2026-08-24: a booking created and
  // checked in through the *old*, now-removed "New booking" flow may
  // never have completed its own transition to CHECKED_IN before that
  // flow was deleted, leaving it stuck at a legacy PENDING status
  // forever with a real, non-null endAt resolved from whatever departure
  // date was given back then. Once that date has passed — plausible days
  // later, guest never actually checked out — that row must still reach
  // the client, because the room itself is still genuinely Occupied (the
  // mock can't exercise Postgres's own OR filtering — the test above
  // already pins the `where` clause's shape; this one guards the rest of
  // the response path for exactly this row).
  it('a pre-redesign booking stuck at a legacy status, with a real endAt already in the past, still shows up as long as its unit is Occupied', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_HEAD'));
    mockPrisma.bookingUnit.findMany.mockResolvedValue([
      {
        unitId: 'unit_1',
        booking: {
          id: 'booking_old',
          referenceNo: 'LWW-260823-0002',
          guestName: 'Old Flow Guest',
          type: 'OVERNIGHT',
          status: 'PENDING',
          startAt: new Date('2026-08-23T06:00:00.000Z'),
          endAt: new Date('2026-08-24T04:00:00.000Z'), // already in the past
        },
      },
    ]);

    const res = await request(createApp()).get('/api/v1/units/unit_1/bookings').set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.bookings).toEqual([
      expect.objectContaining({ referenceNo: 'LWW-260823-0002', status: 'PENDING' }),
    ]);
  });

  it('requires authentication', async () => {
    const res = await request(createApp()).get('/api/v1/units/unit_1/bookings');
    expect(res.status).toBe(401);
  });

  it('is forbidden for a caller without unit:read', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF', { roles: [] }));

    const res = await request(createApp()).get('/api/v1/units/unit_1/bookings').set('Cookie', authCookie());

    expect(res.status).toBe(403);
  });
});

// Cashier-tab plan (spec.md §13.4, Stage B, 2026-11-05): the booking
// picker.
describe('GET /api/v1/bookings/search — the Cashier-tab booking picker', () => {
  it('requires receipt:issue, not just unit:read/booking:checkin', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('HOUSEKEEPING_STAFF', { department: 'HOUSEKEEPING' }));
    const res = await request(createApp()).get('/api/v1/bookings/search').set('Cookie', authCookie());
    expect(res.status).toBe(403);
  });

  // Corrected 2026-11-05 (spec.md §13 decision 16): a CONFIRMED
  // (pre-arrival) booking is exactly as billable as a checked-in one —
  // the whole point of billing-before-check-in — so the default and
  // in_house scope both widened to include it. One list, not a
  // separate scope (client decision): a cashier's question is "find
  // this guest's bill," not "is this guest pre-arrival or in-house."
  it('defaults to in-house + pre-arrival bookings when neither q nor scope is given', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
    mockPrisma.booking.findMany.mockResolvedValue([]);

    const res = await request(createApp()).get('/api/v1/bookings/search').set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(mockPrisma.booking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: { in: ['CHECKED_IN', 'CONFIRMED'] } }) }),
    );
  });

  it('scope=in_house also includes CONFIRMED (pre-arrival) bookings, not just CHECKED_IN', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
    mockPrisma.booking.findMany.mockResolvedValue([]);

    const res = await request(createApp()).get('/api/v1/bookings/search?scope=in_house').set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(mockPrisma.booking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: { in: ['CHECKED_IN', 'CONFIRMED'] } }) }),
    );
  });

  it('scope=recent filters to CHECKED_OUT within the recent-departure window', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
    mockPrisma.booking.findMany.mockResolvedValue([]);

    const res = await request(createApp()).get('/api/v1/bookings/search?scope=recent').set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(mockPrisma.booking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'CHECKED_OUT', endAt: expect.objectContaining({ gte: expect.any(Date) }) }),
      }),
    );
  });

  it('a text query searches guest name, referenceNo, and billing numbers via ReceiptBooking — not Receipt.bookingId', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
    mockPrisma.booking.findMany.mockResolvedValue([
      {
        id: 'booking_1',
        referenceNo: '80512',
        guestName: 'Roel Villagomez',
        status: 'CHECKED_IN',
        arrivalDate: new Date('2026-11-04T00:00:00.000Z'),
        departureDate: null,
        endAt: null,
        units: [{ unit: { code: 'R01', name: 'Room 1' } }],
      },
    ]);

    const res = await request(createApp()).get('/api/v1/bookings/search?q=80512').set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.bookings[0]).toMatchObject({ id: 'booking_1', referenceNo: '80512', guestName: 'Roel Villagomez' });
    expect(res.body.bookings[0].units).toEqual([{ code: 'R01', name: 'Room 1' }]);
    const whereArg = mockPrisma.booking.findMany.mock.calls[0]?.[0]?.where;
    expect(whereArg.OR).toEqual(
      expect.arrayContaining([
        { guestName: { contains: '80512', mode: 'insensitive' } },
        { referenceNo: { contains: '80512', mode: 'insensitive' } },
        { receiptCoverage: { some: { receipt: { billingNumberFull: { contains: '80512', mode: 'insensitive' } } } } },
      ]),
    );
  });
});

// Cashier-tab plan (spec.md §13.4, Stage B, 2026-11-05): a mid-stay room
// change — no UI yet, but the endpoint is tested now so Stage C/D build
// against proven behavior.
describe('POST /api/v1/bookings/:bookingId/move-unit', () => {
  it('requires booking:checkin', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('HOUSEKEEPING_STAFF', { department: 'HOUSEKEEPING' }));
    const res = await request(createApp())
      .post('/api/v1/bookings/booking_1/move-unit')
      .set('Cookie', authCookie())
      .send({ fromUnitId: 'unit_1', toUnitId: 'unit_2' });
    expect(res.status).toBe(403);
  });

  it('closes the old BookingUnit row and opens a new one, flipping unit statuses OCCUPIED->VACANT_DIRTY and READY->OCCUPIED', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
    mockPrisma.booking.findFirst.mockResolvedValue({ id: 'booking_1', referenceNo: '80512', status: 'CHECKED_IN', deletedAt: null });
    mockPrisma.bookingUnit.findFirst.mockResolvedValue({
      id: 'bu_1',
      bookingId: 'booking_1',
      unitId: 'unit_1',
      occupiedTo: null,
      deletedAt: null,
      unit: { id: 'unit_1', code: 'R01', status: 'OCCUPIED' },
    });
    mockPrisma.unit.findFirst.mockImplementation(({ where }: { where: { id: string } }) => {
      if (where.id === 'unit_2') return Promise.resolve({ id: 'unit_2', code: 'R02', type: 'ROOM', status: 'READY', deletedAt: null });
      return Promise.resolve(fakeUnitForTransition({ id: where.id, status: 'OCCUPIED' }));
    });
    mockPrisma.bookingUnit.update.mockResolvedValue({});
    mockPrisma.bookingUnit.create.mockResolvedValue({});

    const res = await request(createApp())
      .post('/api/v1/bookings/booking_1/move-unit')
      .set('Cookie', authCookie())
      .send({ fromUnitId: 'unit_1', toUnitId: 'unit_2' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ bookingId: 'booking_1', fromUnitId: 'unit_1', toUnitId: 'unit_2' });
    // Bug caught in review, 2026-11-06 (spec.md §13 decision 16): both
    // fields close now, not just releasedAt — occupiedTo moves to the
    // move's own moment too, so the vacated room prices for nights
    // actually held, not the stay's original full plan.
    expect(mockPrisma.bookingUnit.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'bu_1' }, data: { releasedAt: expect.any(Date), occupiedTo: expect.any(Date) } }),
    );
    expect(mockPrisma.bookingUnit.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ bookingId: 'booking_1', unitId: 'unit_2', occupiedFrom: expect.any(Date) }) }),
    );
    // Two automatic transitions: the old unit clears, the new one fills.
    expect(mockPrisma.unit.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'VACANT_DIRTY' }) }));
    expect(mockPrisma.unit.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'OCCUPIED' }) }));
  });

  // Bug caught in review, 2026-11-05, found and fixed twice: this query
  // used to be a plain `occupiedTo: null` (only matches a walk-up-
  // created row), then briefly "occupiedTo null OR in the future" (still
  // broke on a late-resolved pre-arrival row once its planned checkout
  // date had passed). `releasedAt: null` is the real, date-independent
  // fix — see BookingUnit.releasedAt's own schema comment.
  it('queries the active assignment by releasedAt: null, not by occupiedTo at all', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
    mockPrisma.booking.findFirst.mockResolvedValue({ id: 'booking_1', referenceNo: '80512', status: 'CHECKED_IN', deletedAt: null });
    mockPrisma.bookingUnit.findFirst.mockResolvedValue(null);

    await request(createApp())
      .post('/api/v1/bookings/booking_1/move-unit')
      .set('Cookie', authCookie())
      .send({ fromUnitId: 'unit_1', toUnitId: 'unit_2' });

    const whereArg = mockPrisma.bookingUnit.findFirst.mock.calls[0]?.[0]?.where;
    expect(whereArg).toEqual(expect.objectContaining({ releasedAt: null }));
  });

  // The actual scenario the first bug produced: a pre-arrival booking's
  // room gets moved before the guest ever arrives. occupiedTo here is a
  // real future Date (what createPreArrivalBooking actually writes) and
  // releasedAt is null (never closed) — proving the move succeeds
  // against that shape, and that closing it writes releasedAt, not
  // occupiedTo (which stays untouched, preserving the planned date for
  // per-night rate resolution).
  it('moves a room on a CONFIRMED (pre-arrival) booking whose BookingUnit.occupiedTo is a future planned checkout date', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
    mockPrisma.booking.findFirst.mockResolvedValue({ id: 'booking_1', referenceNo: 'EXT-200', status: 'CONFIRMED', deletedAt: null });
    mockPrisma.bookingUnit.findFirst.mockResolvedValue({
      id: 'bu_1',
      bookingId: 'booking_1',
      unitId: 'unit_1',
      occupiedTo: new Date('2099-01-01T00:00:00.000Z'),
      releasedAt: null,
      deletedAt: null,
      unit: { id: 'unit_1', code: 'R01', status: 'OCCUPIED' },
    });
    mockPrisma.unit.findFirst.mockImplementation(({ where }: { where: { id: string } }) => {
      if (where.id === 'unit_2') return Promise.resolve({ id: 'unit_2', code: 'R02', type: 'ROOM', status: 'READY', deletedAt: null });
      return Promise.resolve(fakeUnitForTransition({ id: where.id, status: 'OCCUPIED' }));
    });
    mockPrisma.bookingUnit.update.mockResolvedValue({});
    mockPrisma.bookingUnit.create.mockResolvedValue({});

    const res = await request(createApp())
      .post('/api/v1/bookings/booking_1/move-unit')
      .set('Cookie', authCookie())
      .send({ fromUnitId: 'unit_1', toUnitId: 'unit_2' });

    expect(res.status).toBe(200);
    expect(mockPrisma.bookingUnit.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'bu_1' }, data: { releasedAt: expect.any(Date), occupiedTo: expect.any(Date) } }),
    );
  });

  it('422s when the booking has no current, open assignment for fromUnitId', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
    mockPrisma.booking.findFirst.mockResolvedValue({ id: 'booking_1', referenceNo: '80512', status: 'CHECKED_IN', deletedAt: null });
    mockPrisma.bookingUnit.findFirst.mockResolvedValue(null);

    const res = await request(createApp())
      .post('/api/v1/bookings/booking_1/move-unit')
      .set('Cookie', authCookie())
      .send({ fromUnitId: 'unit_1', toUnitId: 'unit_2' });

    expect(res.status).toBe(422);
    expect(mockPrisma.bookingUnit.update).not.toHaveBeenCalled();
  });

  it('409s when the destination unit is already OCCUPIED', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
    mockPrisma.booking.findFirst.mockResolvedValue({ id: 'booking_1', referenceNo: '80512', status: 'CHECKED_IN', deletedAt: null });
    mockPrisma.bookingUnit.findFirst.mockResolvedValue({
      id: 'bu_1',
      bookingId: 'booking_1',
      unitId: 'unit_1',
      occupiedTo: null,
      deletedAt: null,
      unit: { id: 'unit_1', code: 'R01', status: 'OCCUPIED' },
    });
    mockPrisma.unit.findFirst.mockResolvedValue({ id: 'unit_2', code: 'R02', type: 'ROOM', status: 'OCCUPIED', deletedAt: null });

    const res = await request(createApp())
      .post('/api/v1/bookings/booking_1/move-unit')
      .set('Cookie', authCookie())
      .send({ fromUnitId: 'unit_1', toUnitId: 'unit_2' });

    expect(res.status).toBe(409);
    expect(mockPrisma.bookingUnit.update).not.toHaveBeenCalled();
  });

  it('422s when the booking is already closed out (CANCELLED/CHECKED_OUT)', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
    mockPrisma.booking.findFirst.mockResolvedValue({ id: 'booking_1', referenceNo: '80512', status: 'CHECKED_OUT', deletedAt: null });

    const res = await request(createApp())
      .post('/api/v1/bookings/booking_1/move-unit')
      .set('Cookie', authCookie())
      .send({ fromUnitId: 'unit_1', toUnitId: 'unit_2' });

    expect(res.status).toBe(422);
    expect(mockPrisma.bookingUnit.findFirst).not.toHaveBeenCalled();
  });
});

// Cashier-tab plan, spec.md §13 decision 16 (2026-11-05): billing before
// check-in — the cashier bills a READY unit before the guest arrives.
function fakeBookableUnit(overrides: Partial<Record<string, unknown>> = {}) {
  return { id: 'unit_1', code: 'R01', name: 'Room 1', type: 'ROOM', status: 'READY', version: 0, deletedAt: null, ...overrides };
}

function validPreArrivalBody(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    guestName: 'Jane Dela Cruz',
    externalBookingId: 'EXT-200',
    checkInDate: '2026-11-10',
    checkOutDate: '2026-11-12',
    unitId: 'unit_1',
    ...overrides,
  };
}

describe('POST /api/v1/bookings/pre-arrival', () => {
  it('requires booking:checkin', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('HOUSEKEEPING_STAFF', { department: 'HOUSEKEEPING' }));
    const res = await request(createApp()).post('/api/v1/bookings/pre-arrival').set('Cookie', authCookie()).send(validPreArrivalBody());
    expect(res.status).toBe(403);
  });

  // The actual point of decision 16: the booking exists, and the unit
  // is OCCUPIED, immediately — before the guest has set foot in the
  // resort. No CheckInRecord is created here (that's checkInBooking's
  // own job, for the walk-up flow); only the booking and its unit exist.
  it('creates a CONFIRMED booking and moves the unit to OCCUPIED immediately, ahead of arrival', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
    mockPrisma.unit.findFirst.mockResolvedValue(fakeBookableUnit());
    mockPrisma.booking.create.mockResolvedValue({ id: 'booking_1' });
    mockPrisma.booking.findFirst.mockResolvedValue(fakeBookingWithUnits({ status: 'CONFIRMED' }));

    const res = await request(createApp())
      .post('/api/v1/bookings/pre-arrival')
      .set('Cookie', authCookie())
      .send(validPreArrivalBody());

    expect(res.status).toBe(201);
    expect(res.body.booking.status).toBe('CONFIRMED');
    expect(mockPrisma.booking.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          referenceNo: 'EXT-200',
          guestName: 'Jane Dela Cruz',
          status: 'CONFIRMED',
          units: { create: [{ unitId: 'unit_1', occupiedFrom: expect.any(Date), occupiedTo: expect.any(Date) }] },
        }),
      }),
    );
    expect(mockPrisma.unit.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'OCCUPIED' }) }),
    );
    expect(mockPrisma.checkInRecord.create).not.toHaveBeenCalled();
  });

  it('422s when checkOutDate is not after checkInDate', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
    mockPrisma.unit.findFirst.mockResolvedValue(fakeBookableUnit());

    const res = await request(createApp())
      .post('/api/v1/bookings/pre-arrival')
      .set('Cookie', authCookie())
      .send(validPreArrivalBody({ checkInDate: '2026-11-12', checkOutDate: '2026-11-10' }));

    expect(res.status).toBe(422);
    expect(mockPrisma.booking.create).not.toHaveBeenCalled();
  });

  it('409s when the unit is not currently READY', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
    mockPrisma.unit.findFirst.mockResolvedValue(fakeBookableUnit({ status: 'OCCUPIED' }));

    const res = await request(createApp())
      .post('/api/v1/bookings/pre-arrival')
      .set('Cookie', authCookie())
      .send(validPreArrivalBody());

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('UNIT_UNAVAILABLE');
    expect(mockPrisma.booking.create).not.toHaveBeenCalled();
  });

  it.each(['COMMON_AREA', 'FACILITY'])('422s UNIT_NOT_BOOKABLE for a %s unit', async (type) => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
    mockPrisma.unit.findFirst.mockResolvedValue(fakeBookableUnit({ type }));

    const res = await request(createApp())
      .post('/api/v1/bookings/pre-arrival')
      .set('Cookie', authCookie())
      .send(validPreArrivalBody());

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('UNIT_NOT_BOOKABLE');
  });
});

describe('POST /api/v1/bookings/:bookingId/resolve — resolving a CONFIRMED (pre-arrival) booking', () => {
  // Bug caught in review, 2026-11-05, found and fixed twice before this.
  // First version: createPreArrivalBooking writes the *planned*
  // checkout date into occupiedTo (service.ts:340), not null — unlike a
  // walk-up checkInBooking row, which never sets it at all — so a plain
  // `occupiedTo: null` release query matched zero rows. Second version
  // ("occupiedTo null OR still in the future") still broke on a late
  // no-show: once the planned checkout date has actually passed, that
  // predicate excludes the row too, for the same permanently-OCCUPIED
  // outcome. `releasedAt` (BookingUnit's own schema comment has the
  // full reasoning) is the real fix — null is unambiguous regardless of
  // what occupiedTo says or when "now" falls relative to it. The
  // fixture here still carries a future occupiedTo (what
  // createPreArrivalBooking actually writes) specifically so these
  // tests exercise the real shape, not a convenient null that would
  // hide a regression back to either of the first two bugs.
  function fakeConfirmedBooking(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: 'booking_1',
      referenceNo: 'EXT-200',
      guestName: 'Jane Dela Cruz',
      status: 'CONFIRMED',
      deletedAt: null,
      units: [
        {
          id: 'bu_1',
          unitId: 'unit_1',
          occupiedTo: new Date('2099-01-01T00:00:00.000Z'),
          releasedAt: null,
          unit: { id: 'unit_1', code: 'R01', status: 'OCCUPIED' },
        },
      ],
      ...overrides,
    };
  }

  it('requires booking:checkin', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('HOUSEKEEPING_STAFF', { department: 'HOUSEKEEPING' }));
    const res = await request(createApp())
      .post('/api/v1/bookings/booking_1/resolve')
      .set('Cookie', authCookie())
      .send({ toStatus: 'CHECKED_IN' });
    expect(res.status).toBe(403);
  });

  // CHECKED_IN is a pure status flip — the unit is already OCCUPIED
  // from booking time, so no unit-status side effect here.
  it('CHECKED_IN flips the booking status only, with no unit-status side effect', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
    mockPrisma.booking.findFirst.mockResolvedValueOnce(fakeConfirmedBooking()).mockResolvedValueOnce(
      fakeBookingWithUnits({ status: 'CHECKED_IN' }),
    );

    const res = await request(createApp())
      .post('/api/v1/bookings/booking_1/resolve')
      .set('Cookie', authCookie())
      .send({ toStatus: 'CHECKED_IN' });

    expect(res.status).toBe(200);
    expect(mockPrisma.booking.update).toHaveBeenCalledWith({ where: { id: 'booking_1' }, data: { status: 'CHECKED_IN' } });
    expect(mockPrisma.unit.updateMany).not.toHaveBeenCalled();
  });

  // Pins the actual where-clause shape, not just that a release happened
  // — the bug this guards against was invisible to every other test here
  // precisely because the Prisma mock returns units regardless of the
  // filter. "Still held" = releasedAt: null, full stop — never a
  // predicate built on occupiedTo's own value (see BookingUnit.releasedAt's
  // schema comment for why no date-based version of this can work).
  it('queries units by releasedAt: null, not by occupiedTo at all', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
    mockPrisma.booking.findFirst.mockResolvedValueOnce(fakeConfirmedBooking()).mockResolvedValueOnce(
      fakeBookingWithUnits({ status: 'CHECKED_IN' }),
    );

    await request(createApp()).post('/api/v1/bookings/booking_1/resolve').set('Cookie', authCookie()).send({ toStatus: 'CHECKED_IN' });

    const unitsWhere = mockPrisma.booking.findFirst.mock.calls[0]?.[0]?.include?.units?.where;
    expect(unitsWhere).toEqual(expect.objectContaining({ releasedAt: null }));
  });

  // The actual requirement (user's own words): both CANCELLED and
  // NO_SHOW must release the unit, landing it on READY specifically —
  // "a room booked but never slept in isn't dirty" — not VACANT_DIRTY.
  // Also closes the BookingUnit row itself via releasedAt (not
  // occupiedTo, which stays untouched — see that field's own schema
  // comment) — flagged in the same review: otherwise a future
  // per-night rate lookup could see this row and a new booking's row
  // both claiming the same unit on the same date.
  it.each(['CANCELLED', 'NO_SHOW'])('%s releases the unit back to READY, not VACANT_DIRTY, and closes the BookingUnit row via releasedAt', async (toStatus) => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
    mockPrisma.booking.findFirst.mockResolvedValueOnce(fakeConfirmedBooking()).mockResolvedValueOnce(
      fakeBookingWithUnits({ status: toStatus }, [{ unitId: 'unit_1', code: 'R01', status: 'READY' }]),
    );
    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnitForTransition({ status: 'OCCUPIED' }));
    mockPrisma.bookingUnit.update.mockResolvedValue({});

    const res = await request(createApp())
      .post('/api/v1/bookings/booking_1/resolve')
      .set('Cookie', authCookie())
      .send({ toStatus, reason: 'Guest cancelled' });

    expect(res.status).toBe(200);
    expect(mockPrisma.booking.update).toHaveBeenCalledWith({ where: { id: 'booking_1' }, data: { status: toStatus } });
    expect(mockPrisma.bookingUnit.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'bu_1' }, data: { releasedAt: expect.any(Date), occupiedTo: expect.any(Date) } }),
    );
    expect(mockPrisma.unit.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'READY' }) }),
    );
    // READY is excluded from the VACANT_DIRTY-gated auto-housekeeping-
    // ticket guard in applyAutomaticUnitStatusChange — no WorkOrder here.
    expect(mockPrisma.workOrder.create).not.toHaveBeenCalled();
  });

  // The exact scenario the second bug missed, named explicitly: a
  // no-show noticed days after the planned stay, not on the day. A
  // Dec 1-3 booking resolved NO_SHOW on Dec 5 has occupiedTo already in
  // the past — the previous "null OR future" predicate would have
  // excluded this row and left the unit permanently OCCUPIED, exactly
  // reproducing the original bug in the window where it's most likely
  // to actually happen (no-shows are typically noticed late). releasedAt
  // being the sole signal, independent of occupiedTo's own value, means
  // this case is no different from an on-time resolution.
  it('releases the unit for a NO_SHOW resolved days after the planned checkout date has already passed', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
    mockPrisma.booking.findFirst
      .mockResolvedValueOnce(
        fakeConfirmedBooking({
          units: [
            {
              id: 'bu_1',
              unitId: 'unit_1',
              // Planned Dec 1-3; resolved Dec 5 — occupiedTo is two
              // days in the past by the time this call happens.
              occupiedTo: new Date('2026-12-03T00:00:00.000Z'),
              releasedAt: null,
              unit: { id: 'unit_1', code: 'R01', status: 'OCCUPIED' },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(fakeBookingWithUnits({ status: 'NO_SHOW' }, [{ unitId: 'unit_1', code: 'R01', status: 'READY' }]));
    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnitForTransition({ status: 'OCCUPIED' }));
    mockPrisma.bookingUnit.update.mockResolvedValue({});
    vi.setSystemTime(new Date('2026-12-05T10:00:00.000Z'));

    const res = await request(createApp())
      .post('/api/v1/bookings/booking_1/resolve')
      .set('Cookie', authCookie())
      .send({ toStatus: 'NO_SHOW' });

    vi.useRealTimers();

    expect(res.status).toBe(200);
    expect(mockPrisma.bookingUnit.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'bu_1' }, data: { releasedAt: expect.any(Date), occupiedTo: expect.any(Date) } }),
    );
    expect(mockPrisma.unit.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'READY' }) }),
    );
  });

  it('releases every unit of a multi-room pre-arrival booking on cancellation', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
    const futureDate = new Date('2099-01-01T00:00:00.000Z');
    mockPrisma.booking.findFirst
      .mockResolvedValueOnce(
        fakeConfirmedBooking({
          units: [
            { id: 'bu_1', unitId: 'unit_1', occupiedTo: futureDate, unit: { id: 'unit_1', code: 'R01', status: 'OCCUPIED' } },
            { id: 'bu_2', unitId: 'unit_2', occupiedTo: futureDate, unit: { id: 'unit_2', code: 'R02', status: 'OCCUPIED' } },
          ],
        }),
      )
      .mockResolvedValueOnce(
        fakeBookingWithUnits({ status: 'CANCELLED' }, [
          { unitId: 'unit_1', code: 'R01', status: 'READY' },
          { unitId: 'unit_2', code: 'R02', status: 'READY' },
        ]),
      );
    mockPrisma.unit.findFirst.mockImplementation(({ where }: { where: { id: string } }) =>
      Promise.resolve(fakeUnitForTransition({ id: where.id, status: 'OCCUPIED' })),
    );
    mockPrisma.bookingUnit.update.mockResolvedValue({});

    const res = await request(createApp())
      .post('/api/v1/bookings/booking_1/resolve')
      .set('Cookie', authCookie())
      .send({ toStatus: 'CANCELLED' });

    expect(res.status).toBe(200);
    expect(mockPrisma.unit.updateMany).toHaveBeenCalledTimes(2);
    expect(mockPrisma.bookingUnit.update).toHaveBeenCalledTimes(2);
  });

  it('422s when the booking is not CONFIRMED (e.g. already CHECKED_IN)', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
    mockPrisma.booking.findFirst.mockResolvedValue(fakeConfirmedBooking({ status: 'CHECKED_IN' }));

    const res = await request(createApp())
      .post('/api/v1/bookings/booking_1/resolve')
      .set('Cookie', authCookie())
      .send({ toStatus: 'CANCELLED' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVALID_TRANSITION');
    expect(mockPrisma.booking.update).not.toHaveBeenCalled();
  });

  it('404s for an unknown booking', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
    mockPrisma.booking.findFirst.mockResolvedValue(null);

    const res = await request(createApp())
      .post('/api/v1/bookings/booking_bogus/resolve')
      .set('Cookie', authCookie())
      .send({ toStatus: 'CANCELLED' });

    expect(res.status).toBe(404);
  });
});

describe('POST /api/v1/bookings/:bookingId/add-unit — purely additive, distinct from move-unit', () => {
  it('requires booking:checkin', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('HOUSEKEEPING_STAFF', { department: 'HOUSEKEEPING' }));
    const res = await request(createApp())
      .post('/api/v1/bookings/booking_1/add-unit')
      .set('Cookie', authCookie())
      .send({ unitId: 'unit_2' });
    expect(res.status).toBe(403);
  });

  it('opens a new BookingUnit row without closing any existing assignment, and moves the new unit to OCCUPIED', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
    mockPrisma.booking.findFirst
      .mockResolvedValueOnce({ id: 'booking_1', referenceNo: 'EXT-200', status: 'CONFIRMED', deletedAt: null })
      .mockResolvedValueOnce(
        fakeBookingWithUnits({ status: 'CONFIRMED' }, [
          { unitId: 'unit_1', code: 'R01', status: 'OCCUPIED' },
          { unitId: 'unit_2', code: 'R02', status: 'OCCUPIED' },
        ]),
      );
    mockPrisma.unit.findFirst.mockResolvedValue(fakeBookableUnit({ id: 'unit_2', code: 'R02' }));
    mockPrisma.bookingUnit.create.mockResolvedValue({});

    const res = await request(createApp())
      .post('/api/v1/bookings/booking_1/add-unit')
      .set('Cookie', authCookie())
      .send({ unitId: 'unit_2' });

    expect(res.status).toBe(200);
    expect(mockPrisma.bookingUnit.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ bookingId: 'booking_1', unitId: 'unit_2' }) }),
    );
    expect(mockPrisma.bookingUnit.update).not.toHaveBeenCalled();
    expect(mockPrisma.unit.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'unit_2' }), data: expect.objectContaining({ status: 'OCCUPIED' }) }),
    );
  });

  it('409s when the unit to add is not currently READY', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
    mockPrisma.booking.findFirst.mockResolvedValue({ id: 'booking_1', referenceNo: 'EXT-200', status: 'CONFIRMED', deletedAt: null });
    mockPrisma.unit.findFirst.mockResolvedValue(fakeBookableUnit({ id: 'unit_2', status: 'OCCUPIED' }));

    const res = await request(createApp())
      .post('/api/v1/bookings/booking_1/add-unit')
      .set('Cookie', authCookie())
      .send({ unitId: 'unit_2' });

    expect(res.status).toBe(409);
    expect(mockPrisma.bookingUnit.create).not.toHaveBeenCalled();
  });

  it('422s when the booking is already closed out (CANCELLED/CHECKED_OUT/NO_SHOW)', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
    mockPrisma.booking.findFirst.mockResolvedValue({ id: 'booking_1', referenceNo: 'EXT-200', status: 'CHECKED_OUT', deletedAt: null });

    const res = await request(createApp())
      .post('/api/v1/bookings/booking_1/add-unit')
      .set('Cookie', authCookie())
      .send({ unitId: 'unit_2' });

    expect(res.status).toBe(422);
    expect(mockPrisma.bookingUnit.create).not.toHaveBeenCalled();
  });

  it('404s for an unknown booking', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
    mockPrisma.booking.findFirst.mockResolvedValue(null);

    const res = await request(createApp())
      .post('/api/v1/bookings/booking_bogus/add-unit')
      .set('Cookie', authCookie())
      .send({ unitId: 'unit_2' });

    expect(res.status).toBe(404);
  });
});

// Cashier-tab plan, Stage C (2026-11-05): a standalone booking read for
// the billing page — needs the booking's own status and unit list on
// reload, neither conveniently available from any other response.
describe('GET /api/v1/bookings/:bookingId', () => {
  it('requires receipt:issue', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('HOUSEKEEPING_STAFF', { department: 'HOUSEKEEPING' }));
    const res = await request(createApp()).get('/api/v1/bookings/booking_1').set('Cookie', authCookie());
    expect(res.status).toBe(403);
  });

  it('returns the booking with its units, including releasedAt so the frontend can tell a held assignment apart from a moved-away one', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
    mockPrisma.booking.findFirst.mockResolvedValue(
      fakeBookingWithUnits({ status: 'CONFIRMED' }, [{ unitId: 'unit_1', code: 'R01', status: 'OCCUPIED' }]),
    );

    const res = await request(createApp()).get('/api/v1/bookings/booking_1').set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.booking.status).toBe('CONFIRMED');
    expect(res.body.booking.units[0]).toEqual(
      expect.objectContaining({ unitId: 'unit_1', unit: expect.objectContaining({ code: 'R01' }) }),
    );
  });

  it('404s for an unknown booking', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
    mockPrisma.booking.findFirst.mockResolvedValue(null);

    const res = await request(createApp()).get('/api/v1/bookings/booking_bogus').set('Cookie', authCookie());

    expect(res.status).toBe(404);
  });
});
