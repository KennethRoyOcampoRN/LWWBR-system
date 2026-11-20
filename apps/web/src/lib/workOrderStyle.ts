import type { DepartmentKey, WorkOrderPriorityKey, WorkOrderStatusKey, WorkOrderTypeKey } from '@lwwbr/shared';

// Same one-mapping-used-everywhere convention as unitStatusStyle.ts, so
// a future screen can't invent its own inconsistent label/colour for
// the same status.
export const WORK_ORDER_STATUS_LABELS: Record<WorkOrderStatusKey, string> = {
  OPEN: 'Open',
  ASSIGNED: 'Assigned',
  IN_PROGRESS: 'In progress',
  DONE: 'Done',
  VERIFIED: 'Verified',
  REOPENED: 'Reopened',
  CANCELLED: 'Cancelled',
};

// Visual redesign, round 2 (spec.md §13 decision 40, 2026-11-20): same
// fix as UNIT_STATUS_CLASSES — remapped off raw, unvetted Tailwind hues
// onto the five existing semantic tokens, by urgency rather than one
// hue per status. OPEN (unassigned, needs someone to pick it up) and
// REOPENED (failed verification, needs attention again) are the loud
// ones; ASSIGNED/IN_PROGRESS share the same "in motion" info treatment;
// DONE is a quieter success (awaiting verification, not fully closed);
// VERIFIED is full success; CANCELLED is deliberately the quietest —
// closed, nothing left to do, same reasoning as Occupied on the room
// board.
export const WORK_ORDER_STATUS_CLASSES: Record<WorkOrderStatusKey, string> = {
  OPEN: 'bg-warning-50 text-warning-600 border-warning-600',
  ASSIGNED: 'bg-info-50 text-info-600 border-info-600',
  IN_PROGRESS: 'bg-info-50 text-info-600 border-info-600',
  DONE: 'bg-success-50/60 text-success-600 border-success-600/60',
  VERIFIED: 'bg-success-50 text-success-600 border-success-600',
  REOPENED: 'bg-danger-50 text-danger-600 border-danger-600',
  CANCELLED: 'bg-gray-100 text-ink-secondary border-gray-300',
};

export const WORK_ORDER_TYPE_LABELS: Record<WorkOrderTypeKey, string> = {
  HOUSEKEEPING: 'Housekeeping',
  MAINTENANCE: 'Maintenance',
  AMENITY: 'Amenity',
  GENERAL: 'General',
  SAFETY: 'Safety',
  DEEP_CLEAN: 'Deep clean',
};

export const WORK_ORDER_PRIORITY_LABELS: Record<WorkOrderPriorityKey, string> = {
  LOW: 'Low',
  NORMAL: 'Normal',
  HIGH: 'High',
  URGENT: 'Urgent',
};

export const DEPARTMENT_LABELS: Record<DepartmentKey, string> = {
  MANAGEMENT: 'Management',
  FRONT_OFFICE: 'Front Office',
  HOUSEKEEPING: 'Housekeeping',
  MAINTENANCE: 'Maintenance',
  GROUNDS_SAFETY: 'Grounds & Safety',
  RESTAURANT: 'Restaurant',
};
