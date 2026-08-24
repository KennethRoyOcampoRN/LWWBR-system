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

export const AMENITY_REQUEST_STATUS_CLASSES: Record<AmenityRequestStatusKey, string> = {
  REQUESTED: 'bg-gray-100 text-gray-900 border-gray-300',
  APPROVED: 'bg-blue-100 text-blue-900 border-blue-300',
  ISSUED: 'bg-indigo-100 text-indigo-900 border-indigo-300',
  RETURNED: 'bg-green-100 text-green-900 border-green-300',
  OVERDUE: 'bg-amber-100 text-amber-900 border-amber-300',
  CANCELLED: 'bg-red-100 text-red-900 border-red-300',
  LOST_DAMAGED: 'bg-red-100 text-red-900 border-red-300',
};
