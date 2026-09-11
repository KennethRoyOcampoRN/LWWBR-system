// Client-directed feature, 2026-09-18: rest-day requests, using the
// existing RestDayRequest model as-is.
export const REST_DAY_STATUS_KEYS = ['PENDING', 'APPROVED', 'REJECTED'] as const;
export type RestDayStatusKey = (typeof REST_DAY_STATUS_KEYS)[number];

export const REST_DAY_STATUS_LABELS: Record<RestDayStatusKey, string> = {
  PENDING: 'Pending',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
};
