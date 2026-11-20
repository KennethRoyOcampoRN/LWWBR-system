import type { AmenityRequestStatusKey } from '@lwwbr/shared';

// Same one-mapping-used-everywhere convention as workOrderStyle.ts.
export const AMENITY_REQUEST_STATUS_LABELS: Record<AmenityRequestStatusKey, string> = {
  REQUESTED: 'Requested',
  APPROVED: 'Approved',
  ISSUED: 'Issued',
  RETURNED: 'Returned',
  OVERDUE: 'Overdue',
  CANCELLED: 'Cancelled',
  LOST_DAMAGED: 'Lost / damaged',
};

// Visual redesign, round 2 (spec.md §13 decision 40, 2026-11-20): same
// fix as UNIT_STATUS_CLASSES/WORK_ORDER_STATUS_CLASSES — remapped onto
// the five existing semantic tokens by urgency. REQUESTED needs someone
// to approve it; OVERDUE needs someone to chase it down, the loudest
// state here. ISSUED is deliberately quiet — it's out with a guest and
// needs nothing from staff until it's returned or goes overdue, same
// "no action needed" reasoning as Occupied on the room board.
export const AMENITY_REQUEST_STATUS_CLASSES: Record<AmenityRequestStatusKey, string> = {
  REQUESTED: 'bg-warning-50 text-warning-600 border-warning-600',
  APPROVED: 'bg-info-50 text-info-600 border-info-600',
  ISSUED: 'bg-gray-100 text-ink-secondary border-gray-300',
  RETURNED: 'bg-success-50 text-success-600 border-success-600',
  OVERDUE: 'bg-danger-50 text-danger-600 border-danger-600',
  CANCELLED: 'bg-gray-100 text-ink-secondary border-gray-300',
  LOST_DAMAGED: 'bg-danger-50 text-danger-600 border-danger-600',
};
