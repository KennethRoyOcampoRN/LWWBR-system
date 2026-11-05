import type { BookingStatusKey, BookingTypeKey } from '@lwwbr/shared';

// Same one-mapping-used-everywhere convention as unitStatusStyle.ts /
// workOrderStyle.ts. BOOKING_SOURCE_LABELS removed 2026-08-24 — its only
// consumer was the old "New booking" source dropdown, gone along with
// the rest of the reservation-creation flow (redesign, client decision).
export const BOOKING_TYPE_LABELS: Record<BookingTypeKey, string> = {
  OVERNIGHT: 'Overnight',
  DAY_TOUR: 'Day tour',
};

// Cashier-tab plan, Stage C (2026-11-05): the unit card and booking
// picker both need to show a booking's own status now that CONFIRMED
// (pre-arrival) is a real, reachable state again — "distinguish a
// CONFIRMED booking from a CHECKED_IN one... a label or a subtle visual
// difference" (client's own words, spec.md §13 decision 16). PENDING
// stays labeled even though it's legacy/unreachable going forward — a
// pre-2026-08-24 row can still genuinely be stuck there.
export const BOOKING_STATUS_LABELS: Record<BookingStatusKey, string> = {
  PENDING: 'Pending',
  CONFIRMED: 'Booked (not arrived)',
  CHECKED_IN: 'Checked in',
  CHECKED_OUT: 'Checked out',
  CANCELLED: 'Cancelled',
  NO_SHOW: 'No-show',
};

export const BOOKING_STATUS_BADGE_VARIANT: Record<BookingStatusKey, 'success' | 'warning' | 'danger' | 'info' | 'accent' | 'neutral'> = {
  PENDING: 'neutral',
  CONFIRMED: 'warning',
  CHECKED_IN: 'success',
  CHECKED_OUT: 'neutral',
  CANCELLED: 'danger',
  NO_SHOW: 'danger',
};
