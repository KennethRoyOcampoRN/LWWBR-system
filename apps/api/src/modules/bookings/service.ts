import { TZDate } from '@date-fns/tz';
import {
  BOOKING_STATUSES_EXCLUDED_FROM_AVAILABILITY,
  isBookableUnitKind,
  type BookingStatusKey,
  type PermissionKey,
  type PermissionScope,
  type RoleKey,
} from '@lwwbr/shared';
import { getRealtimeAdapter } from '../../adapters/realtime/index.js';
import { ApiError } from '../../lib/apiError.js';
import { prisma } from '../../lib/prisma.js';
// First real cross-module import in this codebase — see
// applyAutomaticUnitStatusChange's own doc comment in units/service.ts
// for why: Unit/UnitStatusEvent lifecycle is owned there, check-in/
// check-out are the trigger, and this avoids a second copy of the
// version-increment / event-write / broadcast logic.
import { applyAutomaticUnitStatusChange } from '../units/service.js';
import type { CheckInBookingInput, CheckOutBookingInput } from './schema.js';

// Redesign, 2026-08-24 (client decision, live-testing feedback): "this
// app's job is monitoring the resort's current, live state, not
// managing reservations... every guest already has a real booking ID
// before arriving." The old availability engine (getBookingWindowSettings,
// resolveDateTime, windowsConflict, createBooking, searchBookings) is
// gone entirely — there's no reservation to create or search for
// anymore. A Booking row now only ever comes into existence via
// checkInBooking below, already occupying real rooms right now.

// Spec §3.2: "Timezone Asia/Manila everywhere... never store naive local
// time." Still used for the one date this flow collects — the check-in
// date — resolved to real midnight in Asia/Manila rather than however
// UTC midnight happens to fall for that calendar day.
const RESORT_TIMEZONE = 'Asia/Manila';

function resolveArrivalDate(dateStr: string): Date {
  const [year, month, day] = dateStr.split('-').map(Number) as [number, number, number];
  return new TZDate(year, month - 1, day, 0, 0, RESORT_TIMEZONE);
}

// department/roles/permissions, added 2026-08-24: applyAutomaticUnitStatusChange
// needs the caller's full identity (not just id) to auto-create the
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

// totalAmount/rate are nullable now (Prisma schema, 2026-08-24) — pricing
// is out of scope, so a Check-in-created row never has one. Number(null)
// would silently coerce to 0, which looks like a real zero-cost booking
// rather than "not collected" — preserved as null instead.
function bookingToJson<
  T extends { totalAmount: unknown; units: { rate: unknown; [k: string]: unknown }[]; [k: string]: unknown },
>(booking: T) {
  return {
    ...booking,
    totalAmount: booking.totalAmount === null ? null : Number(booking.totalAmount),
    units: booking.units.map((u) => ({ ...u, rate: u.rate === null ? null : Number(u.rate) })),
  };
}

// Looks up by internal cuid only. Unlike before the redesign, this is no
// longer also a referenceNo lookup — referenceNo isn't unique anymore
// (see checkInBookingSchema's own comment), so a lookup by that string
// can legitimately match more than one row and has its own dedicated
// query (findOccupiedUnitsForReferenceNo below) rather than pretending a
// single Booking is the answer. Every remaining caller of this function
// already holds a real Booking.id from a row it just created or is
// updating, never a raw string typed by a user.
async function findBookingWithUnits(id: string) {
  const booking = await prisma.booking.findFirst({
    where: { id, deletedAt: null },
    include: { units: { include: { unit: true } } },
  });
  if (!booking) {
    throw new ApiError(404, 'NOT_FOUND', 'Booking not found');
  }
  return booking;
}

export async function getBooking(id: string) {
  const booking = await findBookingWithUnits(id);
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

// Redesign, 2026-08-24: powers the checkout checklist — "show a
// checklist of all rooms tied to that same Booking ID... let the user
// check/uncheck any combination." Groups by the raw referenceNo string
// rather than a single Booking.id, since a group's rooms can have been
// checked in across more than one submission under the same external
// ID (client decision) and each submission is its own Booking row.
//
// Scoped to Unit.status === 'OCCUPIED' as the primary signal, not a
// strict `booking.status === 'CHECKED_IN'` requirement — real gap found
// live-testing 2026-08-24: a booking created and checked in through the
// *old*, now-removed "New booking" flow may never have actually
// transitioned to CHECKED_IN before that flow was deleted, leaving it
// stuck at a legacy PENDING/CONFIRMED status forever (nothing in this
// codebase can move it forward anymore — BOOKING_TRANSITIONS empties
// both edges now). The room itself is still genuinely, physically
// Occupied regardless of what that bookkeeping field says, and that's
// the fact that actually matters for "can this be checked out." Only
// CANCELLED/CHECKED_OUT are excluded — a booking in either state has no
// business being treated as the current occupant of anything.
export async function findOccupiedUnitsForReferenceNo(referenceNo: string) {
  const bookingUnits = await prisma.bookingUnit.findMany({
    where: {
      deletedAt: null,
      booking: { deletedAt: null, referenceNo, status: { notIn: [...BOOKING_STATUSES_EXCLUDED_FROM_AVAILABILITY] } },
      unit: { deletedAt: null, status: 'OCCUPIED' },
    },
    include: {
      unit: { select: { id: true, code: true, name: true, status: true } },
      booking: { select: { id: true, guestName: true } },
    },
    orderBy: { unit: { code: 'asc' } },
  });
  return bookingUnits.map((bu) => ({
    unitId: bu.unit.id,
    code: bu.unit.code,
    name: bu.unit.name,
    bookingId: bu.booking.id,
    guestName: bu.booking.guestName,
  }));
}

// The new, and now only, guest-arrival entry point (client decision,
// 2026-08-24): "every guest ... already arrives with a real external
// booking ID — there is no scenario where a reservation needs to be
// created inside this app." What used to be create-then-separately-
// check-in is now one action — this creates the Booking row directly,
// already CHECKED_IN, at the exact moment the front desk confirms the
// guest is standing there. Validates every selected unit *before*
// writing anything (all-or-nothing for a multi-unit check-in), same
// pattern as the original check-in slice.
export async function checkInBooking(input: CheckInBookingInput, actor: BookingActor) {
  const unitIds = input.units.map((u) => u.unitId);
  if (new Set(unitIds).size !== unitIds.length) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'The same unit was selected more than once.');
  }

  const units = await prisma.unit.findMany({ where: { id: { in: unitIds }, deletedAt: null } });
  if (units.length !== unitIds.length) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'One or more selected units could not be found.');
  }

  for (const unit of units) {
    // Real bug found live-testing, 2026-08-25: common areas (Beach
    // Front, CR-Female/Male, Function Hall, Pool, Restaurant —
    // COMMON_AREA/FACILITY) were checkable-into alongside real guest
    // accommodations. The picker now filters these out client-side
    // (UnitsPage.tsx), but this is the real block — same "never even
    // try, and reject it anyway if it somehow reaches here" pairing as
    // every other unavailable-unit check in this loop.
    if (!isBookableUnitKind(unit.type)) {
      throw new ApiError(422, 'UNIT_NOT_BOOKABLE', `${unit.code} is not a guest accommodation and cannot be checked in.`, {
        unitId: unit.id,
        unitCode: unit.code,
        unitType: unit.type,
      });
    }
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
    if (unit.status !== 'READY' && !input.acknowledgeNotReady) {
      throw new ApiError(
        409,
        'UNIT_NOT_READY',
        `${unit.code} is not Ready yet (currently ${unit.status}) — confirm to check in anyway.`,
        { unitId: unit.id, unitCode: unit.code, unitStatus: unit.status },
      );
    }
  }

  // type/source are constants, not collected by the new form — see the
  // Prisma schema's own comment on Booking for why they're kept rather
  // than dropped (a later milestone may still want them).
  const booking = await prisma.booking.create({
    data: {
      referenceNo: input.externalBookingId,
      guestName: input.guestName,
      source: 'OTHER',
      type: 'OVERNIGHT',
      status: 'CHECKED_IN',
      arrivalDate: resolveArrivalDate(input.checkInDate),
      startAt: new Date(),
      notes: input.notes,
      createdById: actor.id,
      units: { create: unitIds.map((unitId) => ({ unitId })) },
    },
  });

  for (const unit of units) {
    await applyAutomaticUnitStatusChange(unit.id, 'OCCUPIED', actor);
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

  try {
    await getRealtimeAdapter().emit('property', 'booking.checkin', {
      entityId: booking.id,
      actorId: actor.id,
      at: new Date().toISOString(),
      summary: `${input.externalBookingId} checked in — ${input.guestName} (${units.map((u) => u.code).join(', ')})`,
      referenceNo: input.externalBookingId,
      unitIds,
    });
  } catch (error) {
    console.error('Realtime broadcast for booking.checkin failed:', error);
  }

  return getBooking(booking.id);
}

// "Build checkout as a simple, permanent status flip: OCCUPIED ->
// VACANT_DIRTY, unconditional — not gated on any payment-settlement
// check, now or later." No balance/folio check anywhere in this
// function, deliberately — payment lives entirely outside this system
// per the client's own architectural correction, 2026-08-23.
//
// Checklist checkout, redesign 2026-08-24: `unitIds` is the exact set of
// units the front desk confirmed from the checklist — always sent
// explicitly, never inferred, since those units can now legitimately
// belong to more than one Booking row sharing the same external ID (a
// group checked in across more than one submission). Every requested
// unit is validated (currently Occupied, under a CHECKED_IN booking)
// before anything is written — all-or-nothing, same principle as
// check-in's own validate-before-writing pass. Units are grouped by
// their *own* Booking row afterward: a Booking only finalizes to
// CHECKED_OUT — and only then gets its CheckOutRecord — once every one
// of its own units has actually cleared, exactly as before; a partial
// checkout leaves that particular Booking row at CHECKED_IN.
export async function checkOutUnits(unitIds: string[], input: CheckOutBookingInput, actor: BookingActor) {
  const requested = await prisma.bookingUnit.findMany({
    where: { unitId: { in: unitIds }, deletedAt: null, booking: { deletedAt: null } },
    include: { unit: true, booking: { include: { units: { include: { unit: true } } } } },
  });

  const foundUnitIds = new Set(requested.map((bu) => bu.unitId));
  const missing = unitIds.filter((id) => !foundUnitIds.has(id));
  if (missing.length > 0) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'One or more selected units are not part of any active booking.');
  }

  // Real gap found live-testing, 2026-08-24: this used to hard-require
  // `bu.booking.status === 'CHECKED_IN'`, which permanently locked out
  // any booking created through the old, now-removed "New booking" flow
  // that never actually completed its own transition to CHECKED_IN
  // before that flow was deleted — nothing in this codebase can move a
  // legacy PENDING/CONFIRMED booking forward anymore, so a unit stuck
  // behind one had no checkout path at all. Unit.status === 'OCCUPIED'
  // is the real signal that matters — a room is either physically
  // occupied or it isn't, regardless of what the booking's own
  // bookkeeping status says. Only CANCELLED/CHECKED_OUT are rejected — a
  // booking in either state has no business being tied to an Occupied
  // unit's checkout.
  for (const bu of requested) {
    if (bu.unit.status !== 'OCCUPIED') {
      throw new ApiError(422, 'INVALID_TRANSITION', `${bu.unit.code} is not currently Occupied.`);
    }
    if (BOOKING_STATUSES_EXCLUDED_FROM_AVAILABILITY.includes(bu.booking.status as BookingStatusKey)) {
      throw new ApiError(422, 'INVALID_TRANSITION', `${bu.unit.code}'s booking is already closed out.`);
    }
  }

  for (const bu of requested) {
    await applyAutomaticUnitStatusChange(bu.unit.id, 'VACANT_DIRTY', actor);
  }

  // Group the requested units by their own Booking row — a single
  // checkout call can span more than one row (a group checked in across
  // waves under the same external ID), and each row finalizes
  // independently based on whether *its own* units are all clear.
  const requestedUnitIdsByBooking = new Map<string, Set<string>>();
  const bookingById = new Map<string, (typeof requested)[number]['booking']>();
  for (const bu of requested) {
    bookingById.set(bu.booking.id, bu.booking);
    const set = requestedUnitIdsByBooking.get(bu.booking.id) ?? new Set<string>();
    set.add(bu.unit.id);
    requestedUnitIdsByBooking.set(bu.booking.id, set);
  }

  const finalizedBookingIds: string[] = [];
  for (const [bookingId, requestedIds] of requestedUnitIdsByBooking) {
    const booking = bookingById.get(bookingId)!;
    const stillOccupied = booking.units.some(
      (bu) => !requestedIds.has(bu.unit.id) && bu.unit.status === 'OCCUPIED',
    );
    if (stillOccupied) {
      continue;
    }

    await prisma.checkOutRecord.create({
      data: {
        bookingId,
        checkedOutAt: new Date(),
        checkedOutById: actor.id,
        damagesNoted: input.damagesNoted,
        depositRefunded: input.depositRefunded,
      },
    });
    // endAt is the *actual* departure moment now, not a planned one —
    // it was null since Check-in never collects a departure date (see
    // the Prisma schema's own comment on Booking).
    await prisma.booking.update({ where: { id: bookingId }, data: { status: 'CHECKED_OUT', endAt: new Date() } });
    finalizedBookingIds.push(bookingId);

    try {
      await getRealtimeAdapter().emit('property', 'booking.status.changed', {
        entityId: bookingId,
        actorId: actor.id,
        at: new Date().toISOString(),
        summary: `${booking.referenceNo} checked out — ${booking.guestName}`,
        fromStatus: 'CHECKED_IN',
        toStatus: 'CHECKED_OUT',
      });
    } catch (error) {
      console.error('Realtime broadcast for booking.status.changed (check-out) failed:', error);
    }
  }

  return { checkedOutUnitIds: unitIds, finalizedBookingIds };
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
// Deliberately reuses BOOKING_STATUSES_EXCLUDED_FROM_AVAILABILITY rather
// than inventing a second definition of "not relevant anymore." The
// `endAt` filter: `endAt` is nullable (open-ended until actual checkout
// — see the Prisma schema's own comment), so a currently-occupied stay
// with no known end must still show up here — `endAt: null` is included
// alongside `endAt >= now` rather than excluded by a plain `gte` filter,
// which would silently drop every current guest with no set departure.
//
// `unit: { status: 'OCCUPIED' }` added to the same OR, 2026-08-24 — real
// gap found live-testing, twice over. First attempt added `status:
// 'CHECKED_IN'` to this OR, reasoning that a checked-in booking is
// always current regardless of endAt — true, but it assumed every
// legitimately-occupied room's booking actually *reached* CHECKED_IN.
// It doesn't: a booking created through the old, now-removed "New
// booking" flow may never have completed its own transition before that
// flow was deleted, leaving it stuck at a legacy PENDING/CONFIRMED
// status forever — nothing in this codebase can move it forward anymore
// (BOOKING_TRANSITIONS empties both edges now). That first fix still
// filtered such a booking out by endAt once its old departure date
// passed, exactly reproducing the original bug for a booking with a
// stuck status. The room being Occupied is the actual ground truth for
// "is this still current" — not the booking's own bookkeeping status,
// which historical data can leave in an unreachable state this session's
// several redesigns never anticipated. The endAt-based branches still
// matter for a legacy PENDING/CONFIRMED booking whose unit *isn't*
// Occupied (e.g. already manually corrected back to a clean state) — a
// long-past planned arrival that never happened shouldn't linger there.
export async function listUpcomingBookingsForUnit(unitId: string) {
  const bookingUnits = await prisma.bookingUnit.findMany({
    where: {
      unitId,
      deletedAt: null,
      booking: {
        deletedAt: null,
        status: { notIn: [...BOOKING_STATUSES_EXCLUDED_FROM_AVAILABILITY] },
      },
      OR: [{ unit: { status: 'OCCUPIED' } }, { booking: { endAt: null } }, { booking: { endAt: { gte: new Date() } } }],
    },
    include: {
      booking: {
        select: { id: true, referenceNo: true, guestName: true, type: true, status: true, startAt: true, endAt: true },
      },
    },
    orderBy: { booking: { startAt: 'asc' } },
    take: 5,
  });
  return bookingUnits.map((bu) => bu.booking);
}
