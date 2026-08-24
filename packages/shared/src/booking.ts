import type { PermissionKey } from './permissions.js';

// Redesign, 2026-08-24 (client decision, live-testing feedback): this
// app monitors the resort's live state, it does not manage
// reservations — every guest already has a real booking on the
// resort's separate external booking website before arriving, so
// there's no scenario where this app needs to create one, check
// overlapping windows, or enforce a turnaround buffer between
// reservations. The overlap/availability engine (windowsConflict,
// resolveBookingWindow, BookingWindowSettings) that used to live here
// is gone — a Booking row is now created only at the moment of
// check-in (see the units/checkin flow), already occupying real rooms
// right now, not reserving them for a future window.

export const BOOKING_TYPE_KEYS = ['OVERNIGHT', 'DAY_TOUR'] as const;
export type BookingTypeKey = (typeof BOOKING_TYPE_KEYS)[number];

export const BOOKING_SOURCE_KEYS = ['WEBSITE', 'MESSENGER', 'WALK_IN', 'PHONE', 'OTA', 'OTHER'] as const;
export type BookingSourceKey = (typeof BOOKING_SOURCE_KEYS)[number];

// Spec's schema comment infers this set from scattered text elsewhere in
// the doc (§7.6 "a booking currently CHECKED_IN", §8.4 needs a NO_SHOW
// state to report on) rather than spelling it out as a pipe list — see
// the Prisma schema's own comment on BookingStatus for the full
// reasoning. PENDING/CONFIRMED/CANCELLED/NO_SHOW are legacy as of the
// 2026-08-24 redesign — nothing can produce them anymore, see
// BOOKING_TRANSITIONS below — kept only because a live database may
// still hold historical rows in these states from before the redesign.
export const BOOKING_STATUS_KEYS = ['PENDING', 'CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT', 'CANCELLED', 'NO_SHOW'] as const;
export type BookingStatusKey = (typeof BOOKING_STATUS_KEYS)[number];

export interface BookingTransition {
  to: BookingStatusKey;
  permission: PermissionKey;
}

// Simplified, 2026-08-24: a Booking row is now created directly at
// CHECKED_IN (check-in creates it — there's no more "PENDING awaiting
// arrival" step, since every guest already has a real reservation
// elsewhere and this app only records the point they actually show up).
// The only live edge left is the same one as before: CHECKED_IN ->
// CHECKED_OUT. PENDING/CONFIRMED/CANCELLED/NO_SHOW keep empty edges —
// nothing in this codebase can ever produce or act on a booking in one
// of those states anymore, so there's no button to wire up regardless.
export const BOOKING_TRANSITIONS: Record<BookingStatusKey, BookingTransition[]> = {
  PENDING: [],
  CONFIRMED: [],
  CHECKED_IN: [{ to: 'CHECKED_OUT', permission: 'booking:checkout' }],
  CHECKED_OUT: [],
  CANCELLED: [],
  NO_SHOW: [],
};

export function getBookingTransition(from: BookingStatusKey, to: BookingStatusKey): BookingTransition | undefined {
  return (BOOKING_TRANSITIONS[from] ?? []).find((t) => t.to === to);
}

export function canTransitionBooking(from: BookingStatusKey, to: BookingStatusKey): boolean {
  return getBookingTransition(from, to) !== undefined;
}

export function allowedBookingTransitions(
  from: BookingStatusKey,
  permissions: Partial<Record<PermissionKey, unknown>>,
): BookingStatusKey[] {
  return (BOOKING_TRANSITIONS[from] ?? []).filter((t) => permissions[t.permission]).map((t) => t.to);
}

// Still used by listUpcomingBookingsForUnit (the Unit drawer's Bookings
// section) and by the checkout grouping query — a booking in either of
// these states no longer holds its unit(s), so it must never surface as
// something still relevant to a room's current state. NO_SHOW is
// deliberately *not* here for the same historical reason as before, even
// though nothing produces it anymore.
export const BOOKING_STATUSES_EXCLUDED_FROM_AVAILABILITY: readonly BookingStatusKey[] = ['CANCELLED', 'CHECKED_OUT'];
