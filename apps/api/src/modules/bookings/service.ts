import { TZDate } from '@date-fns/tz';
import {
  BOOKING_STATUSES_EXCLUDED_FROM_AVAILABILITY,
  canTransitionBooking,
  DEFAULT_BOOKING_WINDOW_SETTINGS,
  windowsConflict,
  type BookingStatusKey,
  type BookingTypeKey,
  type BookingWindowSettings,
  type PermissionKey,
  type PermissionScope,
  type RoleKey,
} from '@lwwbr/shared';
import { getRealtimeAdapter } from '../../adapters/realtime/index.js';
import { ApiError } from '../../lib/apiError.js';
import { prisma } from '../../lib/prisma.js';
import { generateReferenceNo } from '../../lib/referenceNo.js';
// First real cross-module import in this codebase — see
// applyAutomaticUnitStatusChange's own doc comment in units/service.ts
// for why: Unit/UnitStatusEvent lifecycle is owned there, check-in/
// check-out are the trigger, and this avoids a second copy of the
// version-increment / event-write / broadcast logic.
import { applyAutomaticUnitStatusChange } from '../units/service.js';
import type { CheckInBookingInput, CheckOutBookingInput, CreateBookingInput } from './schema.js';

// Spec §3.2: "Timezone Asia/Manila everywhere... never store naive local
// time." A guest checking in at "2:00 PM" means 2:00 PM in Manila
// regardless of what timezone the server process happens to run in —
// TZDate resolves that wall-clock time to the correct UTC instant, which
// is what actually gets written to the DateTime column.
const RESORT_TIMEZONE = 'Asia/Manila';

const BOOKING_SETTING_KEYS = [
  'booking.dayTourWindow',
  'booking.checkInTime',
  'booking.checkOutTime',
  'booking.turnaroundMinutes',
] as const;

// Spec §7.5: each of these lives in its own Setting row (not one combined
// blob like workOrder.photoRequirements) so the client can loosen or
// tighten just one independently — e.g. change the turnaround buffer
// without touching check-in/out times. Reads the live rows; any missing
// key falls back to the shared default individually, same "never
// silently unenforced" reasoning as getPhotoRequirements in the work
// orders module.
async function getBookingWindowSettings(): Promise<BookingWindowSettings> {
  const rows = await prisma.setting.findMany({ where: { key: { in: [...BOOKING_SETTING_KEYS] } } });
  const byKey = new Map(rows.map((row) => [row.key, row.value]));
  return {
    dayTourWindow:
      (byKey.get('booking.dayTourWindow') as BookingWindowSettings['dayTourWindow'] | undefined) ??
      DEFAULT_BOOKING_WINDOW_SETTINGS.dayTourWindow,
    checkInTime: (byKey.get('booking.checkInTime') as string | undefined) ?? DEFAULT_BOOKING_WINDOW_SETTINGS.checkInTime,
    checkOutTime: (byKey.get('booking.checkOutTime') as string | undefined) ?? DEFAULT_BOOKING_WINDOW_SETTINGS.checkOutTime,
    turnaroundMinutes:
      (byKey.get('booking.turnaroundMinutes') as number | undefined) ?? DEFAULT_BOOKING_WINDOW_SETTINGS.turnaroundMinutes,
  };
}

function parseDateParts(dateStr: string): [number, number, number] {
  const parts = dateStr.split('-').map(Number);
  return [parts[0] ?? 0, parts[1] ?? 1, parts[2] ?? 1];
}

function parseTimeParts(hhmm: string): [number, number] {
  const parts = hhmm.split(':').map(Number);
  return [parts[0] ?? 0, parts[1] ?? 0];
}

function resolveDateTime(dateStr: string, hhmm: string): Date {
  const [year, month, day] = parseDateParts(dateStr);
  const [hours, minutes] = parseTimeParts(hhmm);
  return new TZDate(year, month - 1, day, hours, minutes, RESORT_TIMEZONE);
}

// Spec §7.5: "Day tours are a single fixed block, 9:00 AM - 5:00 PM...
// do not build a slot picker" / overnight resolves from
// booking.checkInTime and booking.checkOutTime. Exported so the same
// resolution logic can be exercised directly in tests without going
// through the full create flow.
export function resolveBookingWindow(
  type: BookingTypeKey,
  arrivalDate: string,
  departureDate: string | undefined,
  settings: BookingWindowSettings,
): { startAt: Date; endAt: Date } {
  if (type === 'DAY_TOUR') {
    return {
      startAt: resolveDateTime(arrivalDate, settings.dayTourWindow.start),
      endAt: resolveDateTime(arrivalDate, settings.dayTourWindow.end),
    };
  }
  // Schema-level validation already guarantees departureDate exists and
  // is after arrivalDate for OVERNIGHT before this is ever called.
  return {
    startAt: resolveDateTime(arrivalDate, settings.checkInTime),
    endAt: resolveDateTime(departureDate as string, settings.checkOutTime),
  };
}

// Plain calendar-day count between two "YYYY-MM-DD" dates, computed as
// UTC midnight so it's immune to any DST edge case (Manila has none
// anyway) — this is a night count for pricing, not a wall-clock
// duration, so it deliberately does not go through TZDate/startAt/endAt.
function nightsBetween(arrivalDate: string, departureDate: string): number {
  const [ay, am, ad] = parseDateParts(arrivalDate);
  const [dy, dm, dd] = parseDateParts(departureDate);
  const arrivalUtc = Date.UTC(ay, am - 1, ad);
  const departureUtc = Date.UTC(dy, dm - 1, dd);
  return Math.round((departureUtc - arrivalUtc) / 86_400_000);
}

// department/roles/permissions, added 2026-08-24: applyAutomaticUnitStatusChange
// now needs the caller's full identity (not just id) to auto-create the
// post-checkout HOUSEKEEPING work order via createWorkOrder, which
// itself expects that shape. req.authUser (router.ts) already carries
// every one of these fields — see AuthenticatedUser in auth/service.ts —
// so no router change was needed to satisfy this.
interface BookingActor {
  id: string;
  department: string;
  roles: readonly RoleKey[];
  permissions: Partial<Record<PermissionKey, PermissionScope>>;
}

function bookingToJson<
  T extends { totalAmount: unknown; units: { rate: unknown; [k: string]: unknown }[]; [k: string]: unknown },
>(booking: T) {
  return {
    ...booking,
    totalAmount: Number(booking.totalAmount),
    units: booking.units.map((u) => ({ ...u, rate: Number(u.rate) })),
  };
}

export async function createBooking(input: CreateBookingInput, actor: BookingActor) {
  const unitIds = input.units.map((u) => u.unitId);
  if (new Set(unitIds).size !== unitIds.length) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'The same unit was selected more than once.');
  }

  const settings = await getBookingWindowSettings();
  const { startAt, endAt } = resolveBookingWindow(input.type, input.arrivalDate, input.departureDate, settings);

  const units = await prisma.unit.findMany({
    where: { id: { in: unitIds }, deletedAt: null },
    include: { unitType: true },
  });
  if (units.length !== unitIds.length) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'One or more selected units could not be found.');
  }
  const unitById = new Map(units.map((u) => [u.id, u]));

  // Spec §7.5: "A unit that is OUT_OF_ORDER or BLOCKED cannot be
  // assigned at all." Checked before the overlap query below — no point
  // computing a conflict window against a unit that can never be booked
  // regardless of dates.
  for (const unit of units) {
    if (unit.status === 'OUT_OF_ORDER' || unit.status === 'BLOCKED') {
      throw new ApiError(
        409,
        'UNIT_UNAVAILABLE',
        `${unit.code} is ${unit.status === 'OUT_OF_ORDER' ? 'out of order' : 'blocked'} and cannot be booked.`,
        { unitId: unit.id, unitCode: unit.code, reason: unit.status },
      );
    }
  }

  // Spec §7.5: "Availability is a datetime overlap check on
  // startAt/endAt across BookingUnit, not a date-equality comparison,"
  // plus the turnaround buffer (windowsConflict, packages/shared).
  // CANCELLED/CHECKED_OUT bookings never hold a unit, so they're
  // excluded from the candidate set entirely rather than filtered after
  // the fact.
  const activeBookingUnits = await prisma.bookingUnit.findMany({
    where: {
      unitId: { in: unitIds },
      deletedAt: null,
      booking: { deletedAt: null, status: { notIn: [...BOOKING_STATUSES_EXCLUDED_FROM_AVAILABILITY] } },
    },
    include: { booking: { select: { referenceNo: true, startAt: true, endAt: true } } },
  });
  for (const existing of activeBookingUnits) {
    if (windowsConflict(startAt, endAt, existing.booking.startAt, existing.booking.endAt, settings.turnaroundMinutes)) {
      const unit = unitById.get(existing.unitId);
      throw new ApiError(
        409,
        'UNIT_UNAVAILABLE',
        `${unit?.code ?? 'This unit'} is already booked (${existing.booking.referenceNo}) for that window.`,
        { unitId: existing.unitId, unitCode: unit?.code, conflictingReferenceNo: existing.booking.referenceNo },
      );
    }
  }

  // Spec §8.3 Cashier form: "rate auto-filled from UnitType and
  // overridable." DAY_TOUR falls back to baseRate when a unit type has
  // no dayTourRate of its own (e.g. a room type that isn't sold as a day
  // tour but could still host one, per UnitType's own `dayTourRate?`
  // optionality in the schema).
  const resolvedUnits = input.units.map((u) => {
    const unit = unitById.get(u.unitId);
    if (!unit) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'One or more selected units could not be found.');
    }
    const fallbackRate = input.type === 'DAY_TOUR' ? (unit.unitType.dayTourRate ?? unit.unitType.baseRate) : unit.unitType.baseRate;
    return { unitId: u.unitId, rate: u.rate ?? Number(fallbackRate) };
  });

  // Simple, defensible pricing for this first slice: per-unit rate times
  // nights for OVERNIGHT, a flat per-unit rate for DAY_TOUR (spec's
  // single fixed block, no per-hour math). Extra-person rates, promos,
  // and multi-night discounting are real features but out of scope here
  // — flagged, not silently assumed away.
  const nights = input.type === 'OVERNIGHT' ? nightsBetween(input.arrivalDate, input.departureDate as string) : 1;
  const totalAmount = resolvedUnits.reduce((sum, u) => sum + u.rate, 0) * nights;

  const referenceNo = await generateReferenceNo('LWW');
  const departureDateValue = input.type === 'DAY_TOUR' ? input.arrivalDate : (input.departureDate as string);

  const booking = await prisma.booking.create({
    data: {
      referenceNo,
      guestName: input.guestName,
      guestPhone: input.guestPhone,
      guestEmail: input.guestEmail,
      source: input.source,
      type: input.type,
      status: 'PENDING',
      pax: input.pax,
      childrenPax: input.childrenPax,
      arrivalDate: new Date(`${input.arrivalDate}T00:00:00.000Z`),
      departureDate: new Date(`${departureDateValue}T00:00:00.000Z`),
      startAt,
      endAt,
      totalAmount,
      notes: input.notes,
      createdById: actor.id,
      units: { create: resolvedUnits },
    },
    include: { units: { include: { unit: { select: { id: true, code: true, name: true } } } } },
  });

  try {
    // Same best-effort, never-fails-the-create pattern as
    // workorder.created — a Realtime outage must never block the
    // booking itself from being saved.
    await getRealtimeAdapter().emit('property', 'booking.created', {
      entityId: booking.id,
      actorId: actor.id,
      at: new Date().toISOString(),
      summary: `${booking.referenceNo} created — ${booking.guestName} (${booking.type})`,
      type: booking.type,
      startAt: booking.startAt.toISOString(),
      endAt: booking.endAt.toISOString(),
    });
  } catch (error) {
    console.error('Realtime broadcast for booking.created failed:', error);
  }

  return bookingToJson(booking);
}

// `id` accepts either the internal cuid or the human-readable
// referenceNo — front desk staff think of "LWW-260823-0003" as the
// booking's id, not the cuid backing it, and spec §6.1 itself calls
// referenceNo the thing "staff will read aloud over radio and type into
// Messenger." Shared by getBooking, checkInBooking, and
// checkOutBooking, all of which need the same booking-with-units shape
// to validate their own transition.
async function findBookingWithUnits(idOrReferenceNo: string) {
  const booking = await prisma.booking.findFirst({
    where: { OR: [{ id: idOrReferenceNo }, { referenceNo: idOrReferenceNo }], deletedAt: null },
    include: { units: { include: { unit: true } } },
  });
  if (!booking) {
    throw new ApiError(404, 'NOT_FOUND', 'Booking not found');
  }
  return booking;
}

export async function getBooking(idOrReferenceNo: string) {
  const booking = await findBookingWithUnits(idOrReferenceNo);
  return bookingToJson({
    ...booking,
    units: booking.units.map((bu) => ({
      id: bu.id,
      unitId: bu.unitId,
      rate: bu.rate,
      unit: { id: bu.unit.id, code: bu.unit.code, name: bu.unit.name, status: bu.unit.status },
    })),
  });
}

// Powers the single lookup panel that drives both check-in and
// check-out — "input an existing Booking ID (or guest name lookup),
// confirm arrival" reuses the exact same search for finding a
// CHECKED_IN booking to check out, so the status filter here covers
// both: PENDING/CONFIRMED (awaiting arrival, checkinable) and
// CHECKED_IN (currently in-house, checkoutable). CHECKED_OUT/CANCELLED/
// NO_SHOW are excluded — nothing actionable left to do with those from
// this panel.
export async function searchBookings(query: string) {
  const bookings = await prisma.booking.findMany({
    where: {
      deletedAt: null,
      status: { in: ['PENDING', 'CONFIRMED', 'CHECKED_IN'] },
      OR: [
        { guestName: { contains: query, mode: 'insensitive' } },
        { referenceNo: { contains: query, mode: 'insensitive' } },
      ],
    },
    include: { units: { include: { unit: { select: { id: true, code: true, name: true, status: true } } } } },
    orderBy: { startAt: 'asc' },
    take: 10,
  });
  return bookings.map((booking) => bookingToJson(booking));
}

// Urgent gap found live-testing, 2026-08-23: "with check-in not yet
// built, there's currently no way to process this guest's arrival at
// all." Deliberately lightweight per the client's own instruction — no
// new date/payment fields, just confirm-arrival against a booking that
// already exists. Validates every unit *before* writing anything
// (all-or-nothing for a multi-unit booking), then applies the real
// automatic READY -> OCCUPIED transition unitStatus.ts's own comment
// has been waiting on since M2.
export async function checkInBooking(idOrReferenceNo: string, input: CheckInBookingInput, actor: BookingActor) {
  const booking = await findBookingWithUnits(idOrReferenceNo);

  const fromStatus = booking.status as BookingStatusKey;
  if (!canTransitionBooking(fromStatus, 'CHECKED_IN')) {
    throw new ApiError(422, 'INVALID_TRANSITION', `Cannot check in a booking from ${fromStatus}`);
  }

  for (const bu of booking.units) {
    const unit = bu.unit;
    if (unit.status === 'OUT_OF_ORDER' || unit.status === 'BLOCKED') {
      throw new ApiError(
        409,
        'UNIT_UNAVAILABLE',
        `${unit.code} is ${unit.status === 'OUT_OF_ORDER' ? 'out of order' : 'blocked'} and cannot be checked in.`,
        { unitId: unit.id, unitCode: unit.code, reason: unit.status },
      );
    }
    if (unit.status === 'OCCUPIED') {
      throw new ApiError(409, 'UNIT_UNAVAILABLE', `${unit.code} is already occupied by another booking.`, {
        unitId: unit.id,
        unitCode: unit.code,
        reason: 'OCCUPIED',
      });
    }
    // Spec §7.5: "A unit that simply isn't READY yet at check-in raises
    // a warning the front desk acknowledges rather than a hard block —
    // real check-ins happen while the room is still being finished."
    // Real edge case flagged in the same report: don't assume check-in
    // only ever happens from a READY room.
    if (unit.status !== 'READY' && !input.acknowledgeNotReady) {
      throw new ApiError(
        409,
        'UNIT_NOT_READY',
        `${unit.code} is not Ready yet (currently ${unit.status}) — confirm to check in anyway.`,
        { unitId: unit.id, unitCode: unit.code, unitStatus: unit.status },
      );
    }
  }

  for (const bu of booking.units) {
    await applyAutomaticUnitStatusChange(bu.unit.id, 'OCCUPIED', actor);
  }

  await prisma.checkInRecord.create({
    data: {
      bookingId: booking.id,
      checkedInAt: new Date(),
      checkedInById: actor.id,
      waiverSigned: input.waiverSigned,
      wristbandsIssued: input.wristbandsIssued,
      keyDepositAmount: input.keyDepositAmount,
      vehiclePlate: input.vehiclePlate,
      idPresented: input.idPresented,
      notes: input.notes,
    },
  });
  await prisma.booking.update({ where: { id: booking.id }, data: { status: 'CHECKED_IN' } });

  try {
    await getRealtimeAdapter().emit('property', 'booking.status.changed', {
      entityId: booking.id,
      actorId: actor.id,
      at: new Date().toISOString(),
      summary: `${booking.referenceNo} checked in — ${booking.guestName}`,
      fromStatus,
      toStatus: 'CHECKED_IN',
    });
  } catch (error) {
    console.error('Realtime broadcast for booking.status.changed (check-in) failed:', error);
  }

  return getBooking(booking.id);
}

// "Build checkout as a simple, permanent status flip: OCCUPIED ->
// VACANT_DIRTY, unconditional — not gated on any payment-settlement
// check, now or later." No balance/folio check anywhere in this
// function, deliberately — payment lives entirely outside this system
// per the client's own architectural correction, 2026-08-23.
//
// Multi-room checkout, added 2026-08-24 (redesign, live-testing
// feedback): "if a booking spans multiple units, checking out from any
// one of those units should ask: check out just this room, or all rooms
// under this booking?" `input.unitId` is that choice — present, checks
// out only that one unit and leaves the rest Occupied; omitted, checks
// out every unit still Occupied under the booking (the original
// all-at-once behavior, still exactly what a single-unit booking's
// checkout does).
//
// The booking itself only finalizes to CHECKED_OUT — and only then gets
// its CheckOutRecord (damages/deposit paperwork) — once every one of its
// units has actually cleared. A partial checkout (some units still
// Occupied) leaves the booking at CHECKED_IN with no CheckOutRecord yet;
// the next checkout call against this same booking (whichever unit
// initiates it) will see it's still CHECKED_IN and can proceed normally.
export async function checkOutBooking(idOrReferenceNo: string, input: CheckOutBookingInput, actor: BookingActor) {
  const booking = await findBookingWithUnits(idOrReferenceNo);

  const fromStatus = booking.status as BookingStatusKey;
  if (!canTransitionBooking(fromStatus, 'CHECKED_OUT')) {
    throw new ApiError(422, 'INVALID_TRANSITION', `Cannot check out a booking from ${fromStatus}`);
  }

  let targetUnits = booking.units;
  if (input.unitId) {
    const match = booking.units.find((bu) => bu.unit.id === input.unitId);
    if (!match) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'That unit is not part of this booking.');
    }
    targetUnits = [match];
  }

  for (const bu of targetUnits) {
    if (bu.unit.status !== 'OCCUPIED') {
      throw new ApiError(422, 'INVALID_TRANSITION', `${bu.unit.code} is not currently Occupied.`);
    }
  }

  for (const bu of targetUnits) {
    await applyAutomaticUnitStatusChange(bu.unit.id, 'VACANT_DIRTY', actor);
  }

  // Units outside targetUnits weren't touched by this call — their
  // status in this already-fetched `booking.units` snapshot is still
  // current. If any of them is still Occupied, this booking isn't fully
  // checked out yet.
  const targetUnitIds = new Set(targetUnits.map((bu) => bu.unit.id));
  const stillOccupiedElsewhere = booking.units.some(
    (bu) => !targetUnitIds.has(bu.unit.id) && bu.unit.status === 'OCCUPIED',
  );
  if (stillOccupiedElsewhere) {
    return getBooking(booking.id);
  }

  await prisma.checkOutRecord.create({
    data: {
      bookingId: booking.id,
      checkedOutAt: new Date(),
      checkedOutById: actor.id,
      damagesNoted: input.damagesNoted,
      depositRefunded: input.depositRefunded,
    },
  });
  await prisma.booking.update({ where: { id: booking.id }, data: { status: 'CHECKED_OUT' } });

  try {
    await getRealtimeAdapter().emit('property', 'booking.status.changed', {
      entityId: booking.id,
      actorId: actor.id,
      at: new Date().toISOString(),
      summary: `${booking.referenceNo} checked out — ${booking.guestName}`,
      fromStatus,
      toStatus: 'CHECKED_OUT',
    });
  } catch (error) {
    console.error('Realtime broadcast for booking.status.changed (check-out) failed:', error);
  }

  return getBooking(booking.id);
}

// Real gap found live-testing, 2026-08-23: bookings existed in complete
// isolation from the Units view — a room could have a guest arriving in
// an hour and the unit drawer showed nothing about it, only its live
// status (correctly still governed by check-in/check-out, not bookings)
// and its status-change Timeline (correctly scoped to status transitions
// only, not reservations). This is a third, separate concept the drawer
// needs: "does this unit have a reservation," shown alongside but never
// blended into either of those two.
//
// Deliberately reuses BOOKING_STATUSES_EXCLUDED_FROM_AVAILABILITY (the
// same set the overlap check itself ignores) rather than inventing a
// second definition of "not relevant anymore" — a booking that can't
// block a new reservation shouldn't be shown as an active one here
// either. The additional `endAt >= now` filter is what actually makes
// this "current or future": excluding CANCELLED/CHECKED_OUT alone would
// still let a merely-old PENDING/NO_SHOW booking linger in the list.
// `unitCount`, added 2026-08-24: powers the Unit drawer's check-out
// prompt — "checking out from any one of those units should ask: check
// out just this room, or all rooms under this booking?" — without a
// second round trip to GET /bookings/:id just to learn how many units a
// booking spans. Deliberately a raw count via `_count`, not the full
// unit list: the drawer only needs the number to decide whether to
// prompt at all (unitCount === 1 never prompts).
export async function listUpcomingBookingsForUnit(unitId: string) {
  const bookingUnits = await prisma.bookingUnit.findMany({
    where: {
      unitId,
      deletedAt: null,
      booking: {
        deletedAt: null,
        status: { notIn: [...BOOKING_STATUSES_EXCLUDED_FROM_AVAILABILITY] },
        endAt: { gte: new Date() },
      },
    },
    include: {
      booking: {
        select: {
          id: true,
          referenceNo: true,
          guestName: true,
          type: true,
          status: true,
          startAt: true,
          endAt: true,
          _count: { select: { units: { where: { deletedAt: null } } } },
        },
      },
    },
    orderBy: { booking: { startAt: 'asc' } },
    take: 5,
  });
  return bookingUnits.map((bu) => {
    const { _count, ...booking } = bu.booking;
    return { ...booking, unitCount: _count.units };
  });
}
