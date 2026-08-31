// Client-directed feature, 2026-08-31: a standalone record for an
// incoming guest payment that needs verification — a guest booked
// manually (not through the automated website flow), paid via bank
// transfer/GCash/etc., and staff submit that payment for OWNER to
// verify. Deliberately unrelated to bookings, units, or the descoped
// Payment/Folio/CashCount system (spec §13 decision 7) — pure standalone
// record, same "monitoring, not transactions" boundary already applied
// elsewhere in this app. See permissions.ts's own comment for why this
// is `remittance:*`, not `payment:*`.
export const REMITTANCE_STATUS_KEYS = ['FOR_VERIFICATION', 'VERIFIED'] as const;
export type RemittanceStatusKey = (typeof REMITTANCE_STATUS_KEYS)[number];

export const REMITTANCE_STATUS_LABELS: Record<RemittanceStatusKey, string> = {
  FOR_VERIFICATION: 'For verification',
  VERIFIED: 'Verified',
};
