import type { RemittanceStatusKey } from '@lwwbr/shared';

// Same one-mapping-used-everywhere convention as amenityRequestStyle.ts.
// Labels live in @lwwbr/shared (REMITTANCE_STATUS_LABELS) — only the
// visual classes are local to the frontend.
export const REMITTANCE_STATUS_CLASSES: Record<RemittanceStatusKey, string> = {
  FOR_VERIFICATION: 'bg-amber-100 text-amber-900 border-amber-300',
  VERIFIED: 'bg-green-100 text-green-900 border-green-300',
};
