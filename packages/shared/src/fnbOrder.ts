import type { PermissionKey } from './permissions.js';

// Spec §7.3's F&B order lifecycle:
//   RECEIVED -> PREPARING -> READY -> SERVED
//       |           |
//   CANCELLED   CANCELLED
// Mirrors the Prisma `FnbOrderStatus` enum. Same explicit-transition-
// table pattern as unitStatus.ts/workOrder.ts/amenityRequest.ts. Unlike
// those two, spec's own diagram already draws every cancel path this
// table needs (both RECEIVED and PREPARING) — no gap to fix by analogy
// this time.
export const FNB_ORDER_STATUS_KEYS = ['RECEIVED', 'PREPARING', 'READY', 'SERVED', 'CANCELLED'] as const;

export type FnbOrderStatusKey = (typeof FNB_ORDER_STATUS_KEYS)[number];

export interface FnbOrderTransition {
  to: FnbOrderStatusKey;
  permission: PermissionKey;
}

// `fnb:update_status` for every transition, spec's own naming — the same
// single capability drags a ticket through every column and cancels it,
// same reasoning as workorder:update_status covering IN_PROGRESS -> DONE.
export const FNB_ORDER_TRANSITIONS: Record<FnbOrderStatusKey, FnbOrderTransition[]> = {
  RECEIVED: [
    { to: 'PREPARING', permission: 'fnb:update_status' },
    { to: 'CANCELLED', permission: 'fnb:update_status' },
  ],
  PREPARING: [
    { to: 'READY', permission: 'fnb:update_status' },
    { to: 'CANCELLED', permission: 'fnb:update_status' },
  ],
  READY: [{ to: 'SERVED', permission: 'fnb:update_status' }],
  SERVED: [],
  CANCELLED: [],
};

export function getFnbOrderTransition(from: FnbOrderStatusKey, to: FnbOrderStatusKey): FnbOrderTransition | undefined {
  return (FNB_ORDER_TRANSITIONS[from] ?? []).find((t) => t.to === to);
}

export function allowedFnbOrderTransitions(
  from: FnbOrderStatusKey,
  permissions: Partial<Record<PermissionKey, unknown>>,
): FnbOrderStatusKey[] {
  return (FNB_ORDER_TRANSITIONS[from] ?? []).filter((t) => permissions[t.permission]).map((t) => t.to);
}

// Spec §7.3: "Kitchen sees a live count of minutes-since-received per
// ticket; ≥20 min turns the card amber, ≥35 min red." Lives here (not
// only in the frontend) so a future report or KPI can reuse the exact
// same thresholds rather than redefining them.
export const FNB_ORDER_AMBER_MINUTES = 20;
export const FNB_ORDER_RED_MINUTES = 35;

export const FNB_ORDER_TYPE_KEYS = ['DINE_IN', 'ROOM_SERVICE', 'ADVANCE_ORDER'] as const;
export type FnbOrderTypeKey = (typeof FNB_ORDER_TYPE_KEYS)[number];

export const FNB_SETTLEMENT_KEYS = ['PAY_NOW', 'CHARGE_TO_ROOM'] as const;
export type FnbSettlementKey = (typeof FNB_SETTLEMENT_KEYS)[number];

// Spec §7.3: "surfaces in the kitchen board 90 minutes before the
// scheduled time (make the lead time a Setting)." Fallback/seed value —
// the API reads the live `fnb.advanceOrderLeadMinutes` Setting row, not
// this constant directly, same pattern as
// DEFAULT_WORK_ORDER_PHOTO_REQUIREMENTS.
export const DEFAULT_FNB_ADVANCE_ORDER_LEAD_MINUTES = 90;
