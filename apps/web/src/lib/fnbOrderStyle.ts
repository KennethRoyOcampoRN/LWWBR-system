import type { FnbOrderStatusKey, FnbOrderTypeKey } from '@lwwbr/shared';

// Same one-mapping-used-everywhere convention as workOrderStyle.ts.
export const FNB_ORDER_STATUS_LABELS: Record<FnbOrderStatusKey, string> = {
  RECEIVED: 'Received',
  PREPARING: 'Preparing',
  READY: 'Ready',
  SERVED: 'Served',
  CANCELLED: 'Cancelled',
};

// Visual redesign, round 2 (spec.md §13 decision 40, 2026-11-20): Order
// history rendered this as plain, uncoloured text — the one status
// column in the app with no colour at all. Same BOOKING_STATUS_BADGE_
// VARIANT convention (bookingStyle.ts), by urgency: RECEIVED needs the
// kitchen to start, READY needs a server to deliver it now — both
// actionable, both warning; PREPARING is visibly in progress; SERVED/
// CANCELLED are closed, quiet, no action needed.
export const FNB_ORDER_STATUS_BADGE_VARIANT: Record<FnbOrderStatusKey, 'success' | 'warning' | 'danger' | 'info' | 'accent' | 'neutral'> = {
  RECEIVED: 'warning',
  PREPARING: 'info',
  READY: 'warning',
  SERVED: 'neutral',
  CANCELLED: 'neutral',
};

export const FNB_ORDER_TYPE_LABELS: Record<FnbOrderTypeKey, string> = {
  DINE_IN: 'Dine-in',
  ROOM_SERVICE: 'Room service',
  ADVANCE_ORDER: 'Advance order',
};
