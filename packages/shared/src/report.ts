// Spec §8.4's MVP report set has 9 entries; M6 builds them in small
// slices rather than all at once (client decision, 2026-08-25) — this
// list only names the ones actually implemented so far. Adding a report
// means adding its key here first, same "shared source of truth" reason
// as every other domain enum in this package: the API's dispatcher and
// the frontend's report picker both read this list rather than each
// hardcoding their own.
// Build plan stage 5 (spec.md §13 decision 13, 2026-11-04): three
// receipts reports, not one overloaded report — client-confirmed as
// three genuinely different shapes/uses (accounting/BIR record, owner
// revenue summary, cashier shift reconciliation), each with a
// materially different row dimension (one row per receipt, one row per
// time bucket, one row per issuing user) that a single report could not
// represent without picking one dimension and losing the others.
export const REPORT_KEYS = [
  'occupancy',
  'work-orders',
  'housekeeping',
  'maintenance-log',
  'fnb-orders',
  'amenity-utilisation',
  'audit-extract',
  'receipts-detail',
  'receipts-summary',
  'receipts-by-cashier',
] as const;

export type ReportKey = (typeof REPORT_KEYS)[number];

export const REPORT_LABELS: Record<ReportKey, string> = {
  occupancy: 'Occupancy & unit status history',
  'work-orders': 'Work orders',
  housekeeping: 'Housekeeping productivity',
  'maintenance-log': 'Maintenance log',
  'fnb-orders': 'F&B orders',
  'amenity-utilisation': 'Amenity utilisation & loss/damage',
  'audit-extract': 'User activity / audit extract',
  'receipts-detail': 'Receipts — detail (accounting record)',
  'receipts-summary': 'Receipts — revenue summary',
  'receipts-by-cashier': 'Receipts — by cashier (shift reconciliation)',
};
