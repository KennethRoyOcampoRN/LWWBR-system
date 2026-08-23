// Spec §6's Booking model + §7.5's availability rules. Mirrors
// workOrder.ts's split: enum-shaped keys/types the frontend and backend
// both need, plus pure helpers with no Prisma/Express dependency so they
// can be unit-tested directly and reused client-side for a preview
// without duplicating the overlap math.

export const BOOKING_TYPE_KEYS = ['OVERNIGHT', 'DAY_TOUR'] as const;
export type BookingTypeKey = (typeof BOOKING_TYPE_KEYS)[number];

export const BOOKING_SOURCE_KEYS = ['WEBSITE', 'MESSENGER', 'WALK_IN', 'PHONE', 'OTA', 'OTHER'] as const;
export type BookingSourceKey = (typeof BOOKING_SOURCE_KEYS)[number];

// Spec's schema comment infers this set from scattered text elsewhere in
// the doc (§7.6 "a booking currently CHECKED_IN", §8.4 needs a NO_SHOW
// state to report on) rather than spelling it out as a pipe list — see
// the Prisma schema's own comment on BookingStatus for the full
// reasoning. The transition table between these states (PENDING ->
// CONFIRMED -> CHECKED_IN -> CHECKED_OUT, CANCELLED/NO_SHOW as escapes)
// is out of scope for this creation-only first M4 slice — every booking
// this slice creates starts at PENDING; check-in/check-out/cancellation
// are later slices.
export const BOOKING_STATUS_KEYS = ['PENDING', 'CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT', 'CANCELLED', 'NO_SHOW'] as const;
export type BookingStatusKey = (typeof BOOKING_STATUS_KEYS)[number];

// A booking in either of these states no longer holds its unit(s) — it
// never happened (CANCELLED) or already ended (CHECKED_OUT) — so it must
// never participate in an availability/overlap check. NO_SHOW is
// deliberately *not* here: a no-show still held the unit for its
// original window and the front desk needs that reflected in the
// timeline, even though no guest arrived.
export const BOOKING_STATUSES_EXCLUDED_FROM_AVAILABILITY: readonly BookingStatusKey[] = ['CANCELLED', 'CHECKED_OUT'];

export interface BookingWindowSettings {
  // "HH:mm" in Asia/Manila, per spec §7.5's Setting shape.
  dayTourWindow: { start: string; end: string };
  checkInTime: string;
  checkOutTime: string;
  turnaroundMinutes: number;
}

// Spec §7.5: "Day tours are a single fixed block, 9:00 AM - 5:00 PM
// (confirmed by the client)." / "Overnight bookings resolve from
// booking.checkInTime (default 14:00) and booking.checkOutTime (default
// 12:00)." / "turnaroundMinutes (default 60)." These are the fallback
// values the backend reads live Setting rows against, seeded once but
// editable later without a deploy — never hardcode 9-to-5 anywhere else.
export const DEFAULT_BOOKING_WINDOW_SETTINGS: BookingWindowSettings = {
  dayTourWindow: { start: '09:00', end: '17:00' },
  checkInTime: '14:00',
  checkOutTime: '12:00',
  turnaroundMinutes: 60,
};

// Spec §7.5: "Availability is a datetime overlap check on startAt/endAt
// across BookingUnit, not a date-equality comparison" plus the
// turnaround buffer. Spec states the buffer directionally ("a booking
// cannot start within turnaroundMinutes of the previous booking's
// endAt"), but the same housekeeping-gap reasoning applies regardless of
// which of the two bookings comes first in time — a new booking ending
// too close to an *already-scheduled later* booking needs the same gap.
// This is applied symmetrically: two windows conflict unless there is at
// least `turnaroundMinutes` of clear time between whichever one ends
// first and whichever one starts second. All arguments are real
// Date/epoch-ms values — this function does no timezone resolution
// itself (see resolveBookingWindow's own doc comment for that).
export function windowsConflict(
  aStart: Date | number,
  aEnd: Date | number,
  bStart: Date | number,
  bEnd: Date | number,
  turnaroundMinutes: number,
): boolean {
  const bufferMs = turnaroundMinutes * 60_000;
  const aStartMs = +aStart;
  const aEndMs = +aEnd;
  const bStartMs = +bStart;
  const bEndMs = +bEnd;
  const aEndsBeforeBWithGap = aEndMs + bufferMs <= bStartMs;
  const bEndsBeforeAWithGap = bEndMs + bufferMs <= aStartMs;
  return !(aEndsBeforeBWithGap || bEndsBeforeAWithGap);
}
