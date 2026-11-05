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
//
// Partially reversed, spec.md §13 decision 16, 2026-11-05: the Cashier
// tab bills a room before the guest arrives — picks a READY unit, sets
// check-in/check-out dates, posts charges — and check-in happens
// against that already-existing booking afterward. CONFIRMED is
// reachable again (see BOOKING_TRANSITIONS below) specifically for
// this pre-arrival window. The deleted overlap engine is NOT rebuilt:
// a pre-arrival booking instead flips its unit straight to OCCUPIED
// (same as a real check-in would), reusing the existing one-booking-
// per-unit guard to prevent two cashiers double-booking the same
// currently-READY room, rather than checking date ranges. PENDING
// stays unreachable — nothing in the client's own description of this
// flow needs a distinct "not yet confirmed" step before CONFIRMED.

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

// Simplified, 2026-08-24, partially reversed 2026-11-05 (spec.md §13
// decision 16). Two live edges now:
// - CHECKED_IN -> CHECKED_OUT: unchanged, the walk-up flow's own path
//   (checkInBooking creates a Booking directly at CHECKED_IN).
// - CONFIRMED -> CHECKED_IN/CANCELLED/NO_SHOW: the Cashier tab's
//   pre-arrival flow — a booking created CONFIRMED by the new
//   pre-arrival creation endpoint, resolved one of three ways by a
//   manual front-desk action. All three gated on booking:checkin, the
//   same actor profile as check-in itself (no automatic no-show timer
//   — considered, deferred). PENDING keeps an empty edge — nothing in
//   the client's own description of this flow needs it.
export const BOOKING_TRANSITIONS: Record<BookingStatusKey, BookingTransition[]> = {
  PENDING: [],
  CONFIRMED: [
    { to: 'CHECKED_IN', permission: 'booking:checkin' },
    { to: 'CANCELLED', permission: 'booking:checkin' },
    { to: 'NO_SHOW', permission: 'booking:checkin' },
  ],
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
// section), the checkout grouping query, and the Cashier-tab plan's
// gatherBookingIdsForBilling (spec.md §13.4) — a booking in any of
// these states no longer holds its unit(s) or has an open folio, so it
// must never surface as something still relevant to a room's current
// state. NO_SHOW added 2026-11-05 (spec.md §13 decision 16) now that
// it's reachable — a booking that never arrived is exactly as "not
// current" as one that already checked out; the unit-release side of
// that transition (flipping the unit back off OCCUPIED) is the new
// NO_SHOW endpoint's own job, not this constant's.
export const BOOKING_STATUSES_EXCLUDED_FROM_AVAILABILITY: readonly BookingStatusKey[] = ['CANCELLED', 'CHECKED_OUT', 'NO_SHOW'];
