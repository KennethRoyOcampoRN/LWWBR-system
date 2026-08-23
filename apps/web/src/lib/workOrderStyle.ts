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

export const WORK_ORDER_STATUS_CLASSES: Record<WorkOrderStatusKey, string> = {
  OPEN: 'bg-gray-100 text-gray-900 border-gray-300',
  ASSIGNED: 'bg-blue-100 text-blue-900 border-blue-300',
  IN_PROGRESS: 'bg-indigo-100 text-indigo-900 border-indigo-300',
  DONE: 'bg-teal-100 text-teal-900 border-teal-300',
  VERIFIED: 'bg-green-100 text-green-900 border-green-300',
  REOPENED: 'bg-amber-100 text-amber-900 border-amber-300',
  CANCELLED: 'bg-red-100 text-red-900 border-red-300',
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
