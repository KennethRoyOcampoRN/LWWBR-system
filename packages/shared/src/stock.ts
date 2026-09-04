// Client-directed feature, 2026-08-31: stock monitoring and purchasing,
// in/out only — no StockRequest approval workflow (see stock:*'s own
// comment in permissions.ts). StockItem/StockMovement were already
// modeled in M0 per spec's Phase 2 backlog note but never wired to any
// code until now.
export const STOCK_CATEGORY_KEYS = ['CLEANING', 'MAINTENANCE', 'KITCHEN', 'OFFICE', 'OTHER'] as const;
export type StockCategoryKey = (typeof STOCK_CATEGORY_KEYS)[number];

export const STOCK_CATEGORY_LABELS: Record<StockCategoryKey, string> = {
  CLEANING: 'Cleaning',
  MAINTENANCE: 'Maintenance',
  KITCHEN: 'Kitchen',
  OFFICE: 'Office',
  OTHER: 'Other',
};

// The underlying Prisma StockMovementReason enum also has TRANSFER —
// deliberately not exposed here. There's no location concept modeled on
// StockItem at all, so "transfer" has nothing to transfer between yet;
// out of scope for this version, not silently dropped.
export const STOCK_MOVEMENT_REASON_KEYS = ['RECEIVE', 'CONSUME', 'ADJUST'] as const;
export type StockMovementReasonKey = (typeof STOCK_MOVEMENT_REASON_KEYS)[number];

export const STOCK_MOVEMENT_REASON_LABELS: Record<StockMovementReasonKey, string> = {
  RECEIVE: 'Received',
  CONSUME: 'Consumed',
  ADJUST: 'Adjusted (miscount correction)',
};
