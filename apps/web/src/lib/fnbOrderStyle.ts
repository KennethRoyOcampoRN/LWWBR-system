import type { FnbOrderStatusKey, FnbOrderTypeKey } from '@lwwbr/shared';

// Same one-mapping-used-everywhere convention as workOrderStyle.ts.
export const FNB_ORDER_STATUS_LABELS: Record<FnbOrderStatusKey, string> = {
  RECEIVED: 'Received',
  PREPARING: 'Preparing',
  READY: 'Ready',
  SERVED: 'Served',
  CANCELLED: 'Cancelled',
};

export const FNB_ORDER_TYPE_LABELS: Record<FnbOrderTypeKey, string> = {
  DINE_IN: 'Dine-in',
  ROOM_SERVICE: 'Room service',
  ADVANCE_ORDER: 'Advance order',
};
