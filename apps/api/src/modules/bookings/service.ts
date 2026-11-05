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
import type {
  AddUnitToBookingInput,
  CheckInBookingInput,
  CheckOutBookingInput,
  CreatePreArrivalBookingInput,
  MoveBookingUnitInput,
  ResolveConfirmedBookingInput,
  SearchBookingsQuery,
} from './schema.js';

// Redesign, 2026-08-24 (client decision, live-testing feedback): "this
// app's job is monitoring the resort's current, live state, not
// managing reservations... every guest already has a real booking ID
// before arriving." The old availability engine (getBookingWindowSettings,
// resolveDateTime, windowsConflict, createBooking, searchBookings) is
// gone entirely — there's no reservation to create or search for
// anymore. A Booking row now only ever comes into existence via
// checkInBooking below, already occupying real rooms right now.

// Spec §3.2: "Timezone Asia/Manila everywhere... never store naive local
// time." Used for every plain calendar date this module collects —
// check-in's own arrival date, and (spec.md §13 decision 16) the
// pre-arrival flow's check-in/check-out dates — resolved to real
// midnight in Asia/Manila rather than however UTC midnight happens to
// fall for that calendar day.
const RESORT_TIMEZONE = 'Asia/Manila';

function resolveManilaDate(dateStr: string): Date {
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
// stuck at a legacy PENDING/CONFIRMED status with no transition back
// then. (CONFIRMED has real edges again as of decision 16's pre-arrival
// flow, but a genuinely stuck pre-redesign row is still just sitting on
// a status nothing will ever act on specifically for it.) The room
// itself is still genuinely, physically Occupied regardless of what
// that bookkeeping field says, and that's the fact that actually
// matters for "can this be checked out." Only
// CANCELLED/CHECKED_OUT/NO_SHOW are excluded — a booking in any of
// those states has no business being treated as the current occupant
// of anything.
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
      arrivalDate: resolveManilaDate(input.checkInDate),
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

// Validates a single candidate unit for either the pre-arrival flow or
// add-room-to-booking — same guard shape as checkInBooking's own loop
// above (not OUT_OF_ORDER/BLOCKED/OCCUPIED, a bookable kind), minus the
// OUT_OF_ORDER/BLOCKED unit's own UNIT_NOT_READY acknowledgement step,
// which neither new flow collects (both only ever offer a currently-
// READY unit to begin with — see each caller's own comment for why).
async function requireAvailableUnitForNewAssignment(unitId: string) {
  const unit = await prisma.unit.findFirst({ where: { id: unitId, deletedAt: null } });
  if (!unit) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'The selected unit could not be found.');
  }
  if (!isBookableUnitKind(unit.type)) {
    throw new ApiError(422, 'UNIT_NOT_BOOKABLE', `${unit.code} is not a guest accommodation.`, {
      unitId: unit.id,
      unitCode: unit.code,
      unitType: unit.type,
    });
  }
  if (unit.status !== 'READY') {
    throw new ApiError(409, 'UNIT_UNAVAILABLE', `${unit.code} is not Ready (currently ${unit.status}).`, {
      unitId: unit.id,
      unitCode: unit.code,
      reason: unit.status,
    });
  }
  return unit;
}

// Bug found in review, 2026-11-05 (spec.md §13 decision 16), then fixed
// twice: `occupiedTo` does not mean "closed" by itself — it means two
// different things depending on who wrote it. `createPreArrivalBooking`
// below writes the *planned* checkout date into it at creation time
// (the assignment is still live; occupiedTo just happens to be
// non-null). `moveBookingUnit` writes the *actual* closure timestamp
// when a room changes. A plain `occupiedTo: null` filter only recognizes
// the walk-up shape and silently excludes every pre-arrival row — the
// first bug found, which left `resolveConfirmedBooking`'s release loop
// running over zero rows for every `CONFIRMED` booking. The first fix
// (`occupiedTo` null OR still in the future) still broke on a late
// no-show: a Dec 1-3 booking resolved `NO_SHOW` on Dec 5 has
// `occupiedTo = Dec 3`, neither null nor in the future by then, so that
// predicate excluded it too — same permanently-`OCCUPIED` outcome, just
// a narrower window. No date-based predicate can resolve this: a past
// `occupiedTo` is genuinely ambiguous between "closed" and "stay whose
// planned end has passed." `BookingUnit.releasedAt` (its own schema
// comment has the full reasoning) is the real fix — null is
// unambiguously "still held," regardless of what `occupiedTo` says or
// when "now" happens to fall.
const ACTIVE_BOOKING_UNIT_WHERE = { releasedAt: null } as const;

// Re-plan, spec.md §13 decision 16, 2026-11-05: billing before check-in.
// The cashier picks a READY unit, sets check-in/check-out dates, and
// the booking exists — and can be billed against — before the guest
// ever arrives. Distinct from checkInBooking above, which stays
// exactly as-is for a walk-up guest already standing there.
//
// The unit goes OCCUPIED right now, not at actual arrival — a
// deliberate substitute for the date-overlap engine the 2026-08-24
// redesign deleted (windowsConflict, BookingWindowSettings). Without
// it, nothing would stop two cashiers booking the same currently-READY
// room for two different stays; reusing the existing one-booking-per-
// unit invariant (a unit can't be OCCUPIED by two bookings at once)
// prevents that for free, with no reservation-window logic to rebuild.
// The cost — a room booked for a future date looks identical on the
// housekeeping board to one with a guest in it right now — is
// mitigated in the frontend by showing the covering booking's own
// status (CONFIRMED vs CHECKED_IN), not by a new UnitStatus (a real
// Reserved status was considered and declined — see decision 16).
//
// checkOutDate is required here (unlike checkInBookingSchema) because
// the night count drives room pricing — it writes straight into the
// new BookingUnit's own occupiedFrom/occupiedTo, the Cashier-tab plan's
// (§13.4) own fields, finally getting a real writer.
export async function createPreArrivalBooking(input: CreatePreArrivalBookingInput, actor: BookingActor) {
  const unit = await requireAvailableUnitForNewAssignment(input.unitId);
  const occupiedFrom = resolveManilaDate(input.checkInDate);
  const occupiedTo = resolveManilaDate(input.checkOutDate);
  if (occupiedTo <= occupiedFrom) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Check-out date must be after check-in date.');
  }

  const booking = await prisma.booking.create({
    data: {
      referenceNo: input.externalBookingId,
      guestName: input.guestName,
      source: 'OTHER',
      type: 'OVERNIGHT',
      status: 'CONFIRMED',
      arrivalDate: occupiedFrom,
      departureDate: occupiedTo,
      startAt: new Date(),
      notes: input.notes,
      createdById: actor.id,
      units: { create: [{ unitId: unit.id, occupiedFrom, occupiedTo }] },
    },
  });

  await applyAutomaticUnitStatusChange(unit.id, 'OCCUPIED', actor);

  try {
    await getRealtimeAdapter().emit('property', 'booking.status.changed', {
      entityId: booking.id,
      actorId: actor.id,
      at: new Date().toISOString(),
      summary: `${input.externalBookingId} billed ahead of arrival — ${input.guestName} (${unit.code})`,
      fromStatus: null,
      toStatus: 'CONFIRMED',
    });
  } catch (error) {
    console.error('Realtime broadcast for booking.status.changed (pre-arrival) failed:', error);
  }

  return getBooking(booking.id);
}

// Resolves a CONFIRMED (pre-arrival) booking one of three ways. All
// three are manual front-desk actions (no automatic no-show timer —
// considered, deferred per decision 16) and all gated booking:checkin
// (BOOKING_TRANSITIONS, packages/shared/src/booking.ts).
//
// CHECKED_IN is a status-only flip — the unit is already OCCUPIED from
// the moment the booking was created, so there's no unit-status side
// effect here, unlike checkInBooking's own walk-up path.
//
// CANCELLED/NO_SHOW both release the unit. A room that was booked but
// never actually slept in isn't dirty — it goes straight back to
// READY, not VACANT_DIRTY (no HOUSEKEEPING ticket either, the same
// toStatus === 'VACANT_DIRTY' guard in applyAutomaticUnitStatusChange
// already excludes READY from that for free). Without this release, a
// cancelled or no-show booking would leave its unit permanently
// OCCUPIED and unbookable — the main failure mode this design
// introduces, and the reason this function exists rather than treating
// the status flip as the whole job. The released BookingUnit row is
// also closed — via releasedAt, not occupiedTo (see that field's own
// schema comment) — not just the Unit row, so it stops reading as
// "still held" once a future per-night rate lookup (spec.md §13.3
// Stage D) needs to tell this row apart from a brand new booking's row
// claiming the same unit once it's READY and rebooked. occupiedTo
// itself is left untouched — it keeps meaning "the planned end of this
// assignment," which Stage D will want preserved regardless of how the
// assignment actually ended.
export async function resolveConfirmedBooking(
  bookingId: string,
  input: ResolveConfirmedBookingInput,
  actor: BookingActor,
) {
  const now = new Date();
  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, deletedAt: null },
    include: { units: { where: { deletedAt: null, ...ACTIVE_BOOKING_UNIT_WHERE }, include: { unit: true } } },
  });
  if (!booking) {
    throw new ApiError(404, 'NOT_FOUND', 'Booking not found');
  }
  if (booking.status !== 'CONFIRMED') {
    throw new ApiError(422, 'INVALID_TRANSITION', 'Only a CONFIRMED (pre-arrival) booking can be resolved this way.');
  }

  await prisma.booking.update({ where: { id: bookingId }, data: { status: input.toStatus } });

  if (input.toStatus === 'CANCELLED' || input.toStatus === 'NO_SHOW') {
    for (const bu of booking.units) {
      await prisma.bookingUnit.update({ where: { id: bu.id }, data: { releasedAt: now } });
      await applyAutomaticUnitStatusChange(bu.unit.id, 'READY', actor);
    }
  }

  try {
    await getRealtimeAdapter().emit('property', 'booking.status.changed', {
      entityId: bookingId,
      actorId: actor.id,
      at: new Date().toISOString(),
      summary: `${booking.referenceNo} ${input.toStatus === 'CHECKED_IN' ? 'checked in' : input.toStatus === 'CANCELLED' ? 'cancelled' : 'marked no-show'} — ${booking.guestName}`,
      fromStatus: 'CONFIRMED',
      toStatus: input.toStatus,
    });
  } catch (error) {
    console.error('Realtime broadcast for booking.status.changed (resolve pre-arrival) failed:', error);
  }

  return getBooking(bookingId);
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

  // Re-tightened 2026-11-05 (spec.md §13 decision 16): this briefly
  // required only "not CANCELLED/CHECKED_OUT" (2026-08-24) because a
  // legacy PENDING/CONFIRMED booking from before that redesign had no
  // way to move forward at all, and this was its only escape hatch.
  // That's no longer true — CONFIRMED now has real forward edges
  // (CHECKED_IN/CANCELLED/NO_SHOW, BOOKING_TRANSITIONS) — so a
  // CONFIRMED (pre-arrival, not-yet-arrived) booking must be routed
  // through one of *those*, not accidentally "checked out" through
  // this endpoint instead. Back to requiring CHECKED_IN specifically.
  for (const bu of requested) {
    if (bu.unit.status !== 'OCCUPIED') {
      throw new ApiError(422, 'INVALID_TRANSITION', `${bu.unit.code} is not currently Occupied.`);
    }
    if (bu.booking.status !== 'CHECKED_IN') {
      throw new ApiError(422, 'INVALID_TRANSITION', `${bu.unit.code}'s booking has not checked in.`);
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
// status with no transition back then (CONFIRMED has real edges again
// as of decision 16, but that doesn't reach a row stuck there from
// before this function's own fix). That first fix still
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

// Cashier-tab plan (spec.md §13.4, Stage B, 2026-11-05): the booking
// picker. There was no bookings-search endpoint at all before this (see
// this file's own top-of-file comment on why it was removed in the
// 2026-08-24 redesign) — this one exists for a narrower, real reason:
// the Cashier tab needs to find a booking to bill, not browse every
// booking ever. "Arriving" was considered and dropped (spec.md §13.4):
// a Booking row is only ever created already CHECKED_IN, so there is
// nothing a pre-arrival filter could ever match.
const RECENT_DEPARTURE_WINDOW_DAYS = 7;

export async function searchBookings(query: SearchBookingsQuery) {
  const scopeFilter: Record<string, unknown> =
    query.scope === 'recent'
      ? { status: 'CHECKED_OUT', endAt: { gte: new Date(Date.now() - RECENT_DEPARTURE_WINDOW_DAYS * 24 * 60 * 60 * 1000) } }
      : query.scope === 'in_house'
        ? { status: 'CHECKED_IN' }
        // No scope and no text query: default to the picker's natural
        // initial view (in-house) rather than "every booking ever."
        : query.q
          ? { status: { not: 'CANCELLED' } }
          : { status: 'CHECKED_IN' };

  const textFilter = query.q
    ? {
        OR: [
          { guestName: { contains: query.q, mode: 'insensitive' as const } },
          { referenceNo: { contains: query.q, mode: 'insensitive' as const } },
          // Matches an already-issued billing number back to whichever
          // Booking row(s) it actually covered — ReceiptBooking, not
          // Receipt.bookingId directly, same reasoning as
          // listReceiptsForBooking in billing/service.ts.
          { receiptCoverage: { some: { receipt: { billingNumberFull: { contains: query.q, mode: 'insensitive' as const } } } } },
        ],
      }
    : {};

  const bookings = await prisma.booking.findMany({
    where: { deletedAt: null, ...scopeFilter, ...textFilter },
    select: {
      id: true,
      referenceNo: true,
      guestName: true,
      status: true,
      arrivalDate: true,
      departureDate: true,
      endAt: true,
      units: { where: { deletedAt: null }, select: { unit: { select: { code: true, name: true } } } },
    },
    orderBy: { startAt: 'desc' },
    take: 50,
  });
  return bookings.map((b) => ({
    id: b.id,
    referenceNo: b.referenceNo,
    guestName: b.guestName,
    status: b.status,
    arrivalDate: b.arrivalDate,
    departureDate: b.departureDate,
    endAt: b.endAt,
    units: b.units.map((bu) => bu.unit),
  }));
}

// Cashier-tab plan (spec.md §13.4, Stage B, 2026-11-05): a mid-stay room
// change under one booking. No UI calls this yet (planned for Stage C).
// Closes the old BookingUnit row and opens a new one for the new unit
// (occupiedFrom = now), same bookingId — this is two writes, not an
// update, per the schema's own comment on BookingUnit. Closing now sets
// releasedAt (not occupiedTo — see BookingUnit.releasedAt's own schema
// comment, added in the same review that found this function's active-
// assignment lookup had the identical bug as resolveConfirmedBooking's
// release query): occupiedTo stays whatever it already meant for this
// row (null for a walk-up assignment, the planned checkout date for a
// pre-arrival one) rather than being overwritten with the move's own
// timestamp, which per-night rate resolution (§13.3 Stage D) will want
// preserved. Reuses booking:checkin rather than minting a new
// permission key: same front-office actor profile as check-in itself.
// Two concurrent BookingUnit rows with overlapping ranges for one
// booking is simply a multi-room booking, not something this function
// needs to detect or prevent — it only ever closes the one row it was
// told to move.
export async function moveBookingUnit(bookingId: string, input: MoveBookingUnitInput, actor: BookingActor) {
  const booking = await prisma.booking.findFirst({ where: { id: bookingId, deletedAt: null } });
  if (!booking) {
    throw new ApiError(404, 'NOT_FOUND', 'Booking not found');
  }
  if (BOOKING_STATUSES_EXCLUDED_FROM_AVAILABILITY.includes(booking.status as BookingStatusKey)) {
    throw new ApiError(422, 'INVALID_TRANSITION', 'This booking is already closed out and cannot be moved.');
  }

  const now = new Date();
  const activeAssignment = await prisma.bookingUnit.findFirst({
    where: { bookingId, unitId: input.fromUnitId, deletedAt: null, ...ACTIVE_BOOKING_UNIT_WHERE },
    include: { unit: true },
  });
  if (!activeAssignment) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'This booking has no current, open assignment for that unit.');
  }

  const toUnit = await prisma.unit.findFirst({ where: { id: input.toUnitId, deletedAt: null } });
  if (!toUnit) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'The destination unit could not be found.');
  }
  if (!isBookableUnitKind(toUnit.type)) {
    throw new ApiError(422, 'UNIT_NOT_BOOKABLE', `${toUnit.code} is not a guest accommodation and cannot be moved into.`);
  }
  if (toUnit.status === 'OUT_OF_ORDER' || toUnit.status === 'BLOCKED' || toUnit.status === 'OCCUPIED') {
    throw new ApiError(409, 'UNIT_UNAVAILABLE', `${toUnit.code} is not available to move into (currently ${toUnit.status}).`, {
      unitId: toUnit.id,
      unitCode: toUnit.code,
      reason: toUnit.status,
    });
  }

  await prisma.bookingUnit.update({ where: { id: activeAssignment.id }, data: { releasedAt: now } });
  await prisma.bookingUnit.create({
    data: { bookingId, unitId: input.toUnitId, occupiedFrom: now },
  });

  await applyAutomaticUnitStatusChange(activeAssignment.unit.id, 'VACANT_DIRTY', actor);
  await applyAutomaticUnitStatusChange(toUnit.id, 'OCCUPIED', actor);

  try {
    await getRealtimeAdapter().emit('property', 'booking.status.changed', {
      entityId: bookingId,
      actorId: actor.id,
      at: now.toISOString(),
      summary: `${booking.referenceNo} moved from ${activeAssignment.unit.code} to ${toUnit.code}`,
      fromStatus: booking.status,
      toStatus: booking.status,
    });
  } catch (error) {
    console.error('Realtime broadcast for booking.status.changed (room move) failed:', error);
  }

  return { bookingId, fromUnitId: input.fromUnitId, toUnitId: input.toUnitId };
}

// Add-room-to-booking (spec.md §13 decision 16, 2026-11-05) — distinct
// from moveBookingUnit above: this never closes an existing assignment,
// it only ever opens a new one. Same unit-availability guard as
// createPreArrivalBooking (a currently-READY unit only), and the new
// unit goes OCCUPIED the same way — "if they have several rooms" (the
// client's own words) is this call, repeated once per extra room, not
// a units array on the original booking call.
export async function addUnitToBooking(bookingId: string, input: AddUnitToBookingInput, actor: BookingActor) {
  const booking = await prisma.booking.findFirst({ where: { id: bookingId, deletedAt: null } });
  if (!booking) {
    throw new ApiError(404, 'NOT_FOUND', 'Booking not found');
  }
  if (BOOKING_STATUSES_EXCLUDED_FROM_AVAILABILITY.includes(booking.status as BookingStatusKey)) {
    throw new ApiError(422, 'INVALID_TRANSITION', 'This booking is already closed out — a room cannot be added to it.');
  }

  const unit = await requireAvailableUnitForNewAssignment(input.unitId);
  const now = new Date();
  await prisma.bookingUnit.create({ data: { bookingId, unitId: unit.id, occupiedFrom: now } });
  await applyAutomaticUnitStatusChange(unit.id, 'OCCUPIED', actor);

  try {
    await getRealtimeAdapter().emit('property', 'booking.status.changed', {
      entityId: bookingId,
      actorId: actor.id,
      at: now.toISOString(),
      summary: `${booking.referenceNo} added ${unit.code}`,
      fromStatus: booking.status,
      toStatus: booking.status,
    });
  } catch (error) {
    console.error('Realtime broadcast for booking.status.changed (add room) failed:', error);
  }

  return getBooking(bookingId);
}
