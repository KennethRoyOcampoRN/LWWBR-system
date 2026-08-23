import type { PermissionKey } from './permissions.js';

// Spec §7.2's work order lifecycle:
//   OPEN -> ASSIGNED -> IN_PROGRESS -> DONE -> VERIFIED
//              |             |           |
//          CANCELLED     CANCELLED    REOPENED -> IN_PROGRESS
// Mirrors the Prisma `WorkOrderStatus` enum. Spec §7: "Implement each as
// an explicit transition table in packages/shared... never duplicate
// this logic" — same pattern as packages/shared/src/unitStatus.ts.
export const WORK_ORDER_STATUS_KEYS = [
  'OPEN',
  'ASSIGNED',
  'IN_PROGRESS',
  'DONE',
  'VERIFIED',
  'REOPENED',
  'CANCELLED',
] as const;

export type WorkOrderStatusKey = (typeof WORK_ORDER_STATUS_KEYS)[number];

export interface WorkOrderTransition {
  to: WorkOrderStatusKey;
  permission: PermissionKey;
}

// { from: transition[] }, same shape as unitStatus.ts's table for the
// same reason: one lookup answers "what can this ticket become," which
// is what both the API's validator and a future UI's action-button list
// need.
//
// Permission choices, reasoned through since spec states the target
// states but not every gate explicitly:
// - OPEN -> ASSIGNED: `workorder:assign`, spec's own naming.
// - ASSIGNED -> IN_PROGRESS, REOPENED -> IN_PROGRESS: `workorder:update_status`
//   — the assigned tech progressing their own ticket.
// - IN_PROGRESS -> DONE: also `workorder:update_status`. The §7.2.1
//   mandatory-COMPLETION-photo gate is enforced separately in the
//   service layer (like the unit module's photo-adjacent rules aren't
//   encoded as a transition permission either) — a photo requirement
//   isn't a *who* question, it's a *what's attached* question.
// - ASSIGNED -> CANCELLED, IN_PROGRESS -> CANCELLED: `workorder:close`
//   — the one operational permission spec lists alongside assign/verify/
//   update_status that isn't used elsewhere in this table, and
//   "closing" a ticket without completing it is exactly what cancelling
//   mid-flight is.
// - DONE -> VERIFIED, DONE -> REOPENED: both `workorder:verify` — spec:
//   "DONE -> VERIFIED requires workorder:verify... DONE -> REOPENED when
//   QC fails." Verifying and rejecting are the same QC check's two
//   outcomes, done by the same person. Spec also says "only the
//   department POC or above may verify" — that's a department-match
//   rule the generic ALL-scoped `workorder:verify` grant doesn't encode
//   on its own (POC_HOUSEKEEPING and POC_MAINTENANCE both hold it at
//   `ALL` scope, not `DEPARTMENT`), so it needs an explicit
//   actor.department === workOrder.department check in the service
//   layer once the verify endpoint is built — not yet built this slice.
//
// Not yet resolved, flagged rather than silently decided: spec's own
// ASCII diagram only draws a CANCELLED arrow from ASSIGNED and
// IN_PROGRESS, not from OPEN — so an unassigned ticket currently has no
// cancel path in this table, matching the diagram literally rather than
// assuming it's an omission.
export const WORK_ORDER_TRANSITIONS: Record<WorkOrderStatusKey, WorkOrderTransition[]> = {
  OPEN: [{ to: 'ASSIGNED', permission: 'workorder:assign' }],
  ASSIGNED: [
    { to: 'IN_PROGRESS', permission: 'workorder:update_status' },
    { to: 'CANCELLED', permission: 'workorder:close' },
  ],
  IN_PROGRESS: [
    { to: 'DONE', permission: 'workorder:update_status' },
    { to: 'CANCELLED', permission: 'workorder:close' },
  ],
  DONE: [
    { to: 'VERIFIED', permission: 'workorder:verify' },
    { to: 'REOPENED', permission: 'workorder:verify' },
  ],
  REOPENED: [{ to: 'IN_PROGRESS', permission: 'workorder:update_status' }],
  VERIFIED: [],
  CANCELLED: [],
};

export function getWorkOrderTransition(
  from: WorkOrderStatusKey,
  to: WorkOrderStatusKey,
): WorkOrderTransition | undefined {
  return (WORK_ORDER_TRANSITIONS[from] ?? []).find((t) => t.to === to);
}

export function canTransitionWorkOrder(from: WorkOrderStatusKey, to: WorkOrderStatusKey): boolean {
  return getWorkOrderTransition(from, to) !== undefined;
}

export function allowedWorkOrderTransitions(
  from: WorkOrderStatusKey,
  permissions: Partial<Record<PermissionKey, unknown>>,
): WorkOrderStatusKey[] {
  return (WORK_ORDER_TRANSITIONS[from] ?? []).filter((t) => permissions[t.permission]).map((t) => t.to);
}

export const WORK_ORDER_TYPE_KEYS = [
  'HOUSEKEEPING',
  'MAINTENANCE',
  'AMENITY',
  'GENERAL',
  'SAFETY',
  'DEEP_CLEAN',
] as const;
export type WorkOrderTypeKey = (typeof WORK_ORDER_TYPE_KEYS)[number];

export const WORK_ORDER_PRIORITY_KEYS = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
export type WorkOrderPriorityKey = (typeof WORK_ORDER_PRIORITY_KEYS)[number];

export const WORK_ORDER_PHOTO_KIND_KEYS = ['ISSUE', 'PROGRESS', 'COMPLETION'] as const;
export type WorkOrderPhotoKindKey = (typeof WORK_ORDER_PHOTO_KIND_KEYS)[number];

// Spec §7.2.1's table, as the default value of the `workOrder.
// photoRequirements` Setting — "so the client can loosen or tighten it
// later without a deploy." This is the fallback/seed value; the API
// reads the live Setting row, not this constant directly, once one
// exists (falling back to this if the row is somehow missing so the
// gate is never silently unenforced).
export const DEFAULT_WORK_ORDER_PHOTO_REQUIREMENTS: Record<
  WorkOrderTypeKey,
  { onCreate: WorkOrderPhotoKindKey[]; onDone: WorkOrderPhotoKindKey[] }
> = {
  HOUSEKEEPING: { onCreate: [], onDone: [] },
  MAINTENANCE: { onCreate: ['ISSUE'], onDone: ['COMPLETION'] },
  AMENITY: { onCreate: [], onDone: [] },
  GENERAL: { onCreate: [], onDone: [] },
  SAFETY: { onCreate: ['ISSUE'], onDone: ['COMPLETION'] },
  DEEP_CLEAN: { onCreate: [], onDone: ['COMPLETION'] },
};
