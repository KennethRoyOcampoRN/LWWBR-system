import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPrisma = {
  user: { findFirst: vi.fn() },
  setting: { findMany: vi.fn(), findUnique: vi.fn() },
  unit: { findMany: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
  unitStatusEvent: { create: vi.fn() },
  bookingUnit: { findMany: vi.fn() },
  booking: { create: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
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
  return { id: 'unit_1', code: 'R01', name: 'Room 1', status: 'READY', deletedAt: null, ...overrides };
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
    unit: { id: u.unitId, code: u.code, name: `Room ${u.code}`, status: u.status },
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

  // Real gap found live-testing, 2026-08-24: a booking created and
  // checked in through the old, now-removed "New booking" flow may never
  // have completed its own transition to CHECKED_IN before that flow was
  // deleted — nothing in this codebase can move a legacy PENDING/
  // CONFIRMED booking forward anymore, so a unit stuck behind one
  // previously had no checkout path at all. The room being Occupied is
  // what actually matters — not the booking's own stuck bookkeeping
  // status.
  it('checks out a unit whose booking is stuck at a legacy PENDING status, as long as the unit itself is Occupied', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_HEAD'));
    const booking = fakeBookingWithUnits({ status: 'PENDING' });
    mockPrisma.bookingUnit.findMany.mockResolvedValue([bookingUnitRow('unit_1', booking)]);
    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnitForTransition({ status: 'OCCUPIED' }));

    const res = await request(createApp()).post('/api/v1/bookings/checkout').set('Cookie', authCookie()).send({ unitIds: ['unit_1'] });

    expect(res.status).toBe(200);
    expect(res.body.finalizedBookingIds).toEqual(['booking_1']);
    expect(mockPrisma.unit.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'VACANT_DIRTY' }) }),
    );
    expect(mockPrisma.checkOutRecord.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ bookingId: 'booking_1' }) }),
    );
    expect(mockPrisma.booking.update).toHaveBeenCalledWith({
      where: { id: 'booking_1' },
      data: expect.objectContaining({ status: 'CHECKED_OUT' }),
    });
  });

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
