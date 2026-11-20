import type { AnyUnitStatusKey } from '@lwwbr/shared';

// Spec §8.2: "a card per unit, colour + label coded by status." One
// mapping, used everywhere a status badge renders, so a new screen can't
// invent its own inconsistent color for the same status.
//
// Typed against AnyUnitStatusKey (not the forward-only UnitStatusKey),
// and still carries an INSPECTED entry even though it was retired
// 2026-08-22 (client decision — see packages/shared/src/unitStatus.ts):
// a historical UnitStatusEvent can legitimately reference it forever,
// and a live Unit row can still hold it until someone force-corrects it
// after this deploy. Missing an entry here would render `undefined` (or
// crash a lookup) for that one row instead of degrading gracefully.
export const UNIT_STATUS_LABELS: Record<AnyUnitStatusKey, string> = {
  VACANT_DIRTY: 'Dirty',
  CLEANING: 'Cleaning',
  CLEANED: 'Cleaned',
  INSPECTED: 'Inspected',
  READY: 'Ready',
  OCCUPIED: 'Occupied',
  OUT_OF_ORDER: 'Out of order',
  BLOCKED: 'Blocked',
};

// Visual redesign, round 2 (spec.md §13 decision 40, 2026-11-20),
// client-reported: this used to be eight raw, unvetted Tailwind hues
// (amber/blue/teal/indigo/green/purple/red/gray) with zero connection
// to the five semantic, WCAG-measured tokens (success/warning/danger/
// info/accent) StatusBadge/Button already route through — "colour
// spent as decoration, not meaning," confirmed true of this exact file.
//
// Remapped onto those five existing tokens by *urgency/action-needed*,
// not one hue per category — a resort board read at a glance has one
// job, telling the reader what needs doing, and a different colour per
// status for its own sake spends that signal on taxonomy instead:
//   warning  — VACANT_DIRTY: needs housekeeping now, the loudest tile
//   info     — CLEANING: visibly in progress, someone's on it
//   success  — CLEANED/READY: good or nearly there (CLEANED one step
//              quieter — an outline/tint of the same hue — since it
//              isn't bookable yet, just close)
//   danger   — OUT_OF_ORDER/BLOCKED: out of service, needs maintenance
//              or an admin; told apart by label text, not a second red
// OCCUPIED is deliberately the *quietest* tile on the whole board, not
// the loudest — the client's own diagnosis: `purple-100` was the hue
// closest to brand violet, so a fully-booked night read as the most
// visually urgent state on the board and an empty one read as calm,
// which is backwards. Occupied needs nothing from anyone; a plain,
// ink-neutral surface says so at a glance, the same way Ready's calm
// green does, leaving every saturated tile on the board a real signal.
export const UNIT_STATUS_CLASSES: Record<AnyUnitStatusKey, string> = {
  VACANT_DIRTY: 'bg-warning-50 text-warning-600 border-warning-600',
  CLEANING: 'bg-info-50 text-info-600 border-info-600',
  CLEANED: 'bg-success-50/60 text-success-600 border-success-600/60',
  INSPECTED: 'bg-gray-100 text-ink-secondary border-gray-300',
  READY: 'bg-success-50 text-success-600 border-success-600',
  OCCUPIED: 'bg-white text-ink-secondary border-gray-300',
  OUT_OF_ORDER: 'bg-danger-50 text-danger-600 border-danger-600',
  BLOCKED: 'bg-gray-100 text-danger-600 border-gray-400',
};
