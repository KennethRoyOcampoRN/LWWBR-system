import { TZDate } from '@date-fns/tz';
import {
  BOOKING_STATUSES_EXCLUDED_FROM_AVAILABILITY,
  DEFAULT_BOOKING_WINDOW_SETTINGS,
  windowsConflict,
  type BookingTypeKey,
  type BookingWindowSettings,
} from '@lwwbr/shared';
import { getRealtimeAdapter } from '../../adapters/realtime/index.js';
import { ApiError } from '../../lib/apiError.js';
import { prisma } from '../../lib/prisma.js';
import { generateReferenceNo } from '../../lib/referenceNo.js';
import type { CreateBookingInput } from './schema.js';

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

interface BookingActor {
  id: string;
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
