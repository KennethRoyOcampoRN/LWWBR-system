import type { BookingSourceKey, BookingTypeKey } from '@lwwbr/shared';

// Same one-mapping-used-everywhere convention as unitStatusStyle.ts /
// workOrderStyle.ts.
export const BOOKING_TYPE_LABELS: Record<BookingTypeKey, string> = {
  OVERNIGHT: 'Overnight',
  DAY_TOUR: 'Day tour',
};

export const BOOKING_SOURCE_LABELS: Record<BookingSourceKey, string> = {
  WEBSITE: 'Website',
  MESSENGER: 'Messenger',
  WALK_IN: 'Walk-in',
  PHONE: 'Phone',
  OTA: 'OTA',
  OTHER: 'Other',
};
