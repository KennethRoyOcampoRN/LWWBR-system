// Client-directed feature, 2026-09-18: DTR (time in/out). Source is
// always WEB for the clock-in/out endpoints this slice builds — MANUAL
// is the existing enum value reserved for a future admin-entered
// correction flow, not built here (no route sets it).
export const TIME_LOG_SOURCE_KEYS = ['WEB', 'MANUAL'] as const;
export type TimeLogSourceKey = (typeof TIME_LOG_SOURCE_KEYS)[number];

export const TIME_LOG_SOURCE_LABELS: Record<TimeLogSourceKey, string> = {
  WEB: 'Web',
  MANUAL: 'Manual',
};
