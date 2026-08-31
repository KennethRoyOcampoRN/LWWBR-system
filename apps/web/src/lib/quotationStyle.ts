import type { QuotationStatusKey } from '@lwwbr/shared';

// Same one-mapping-used-everywhere convention as amenityRequestStyle.ts.
export const QUOTATION_STATUS_CLASSES: Record<QuotationStatusKey, string> = {
  PENDING: 'bg-gray-100 text-gray-900 border-gray-300',
  DONE: 'bg-green-100 text-green-900 border-green-300',
};
