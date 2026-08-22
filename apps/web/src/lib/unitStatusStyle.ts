import type { UnitStatusKey } from '@lwwbr/shared';

// Spec §8.2: "a card per unit, colour + label coded by status." One
// mapping, used everywhere a status badge renders, so a new screen can't
// invent its own inconsistent color for the same status.
export const UNIT_STATUS_LABELS: Record<UnitStatusKey, string> = {
  VACANT_DIRTY: 'Dirty',
  CLEANING: 'Cleaning',
  CLEANED: 'Cleaned',
  INSPECTED: 'Inspected',
  READY: 'Ready',
  OCCUPIED: 'Occupied',
  OUT_OF_ORDER: 'Out of order',
  BLOCKED: 'Blocked',
};

export const UNIT_STATUS_CLASSES: Record<UnitStatusKey, string> = {
  VACANT_DIRTY: 'bg-amber-100 text-amber-900 border-amber-300',
  CLEANING: 'bg-blue-100 text-blue-900 border-blue-300',
  CLEANED: 'bg-teal-100 text-teal-900 border-teal-300',
  INSPECTED: 'bg-indigo-100 text-indigo-900 border-indigo-300',
  READY: 'bg-green-100 text-green-900 border-green-300',
  OCCUPIED: 'bg-purple-100 text-purple-900 border-purple-300',
  OUT_OF_ORDER: 'bg-red-100 text-red-900 border-red-300',
  BLOCKED: 'bg-gray-200 text-gray-900 border-gray-400',
};
