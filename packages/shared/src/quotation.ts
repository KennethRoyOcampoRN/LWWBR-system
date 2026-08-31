// Client-directed feature, 2026-08-31: a standalone quotation-request
// record (prospective guest asking for a rate quote before booking) —
// unrelated to bookings, units, or payments. Just two states, no third
// option, per the client's own spec.
export const QUOTATION_STATUS_KEYS = ['PENDING', 'DONE'] as const;
export type QuotationStatusKey = (typeof QUOTATION_STATUS_KEYS)[number];

export const QUOTATION_STATUS_LABELS: Record<QuotationStatusKey, string> = {
  PENDING: 'Pending',
  DONE: 'Done',
};
