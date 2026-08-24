import type { BookingTypeKey } from '@lwwbr/shared';

// Same one-mapping-used-everywhere convention as unitStatusStyle.ts /
// workOrderStyle.ts. BOOKING_SOURCE_LABELS removed 2026-08-24 — its only
// consumer was the old "New booking" source dropdown, gone along with
// the rest of the reservation-creation flow (redesign, client decision).
export const BOOKING_TYPE_LABELS: Record<BookingTypeKey, string> = {
  OVERNIGHT: 'Overnight',
  DAY_TOUR: 'Day tour',
};
