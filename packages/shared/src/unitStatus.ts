import type { PermissionKey } from './permissions.js';

// Spec §7.1's unit status cycle:
//   VACANT_DIRTY -> CLEANING -> CLEANED -> INSPECTED -> READY -> OCCUPIED -> VACANT_DIRTY
// plus OUT_OF_ORDER / BLOCKED reachable from almost any state, both
// returning only to VACANT_DIRTY. Mirrors the Prisma `UnitStatus` enum.
export const UNIT_STATUS_KEYS = [
  'VACANT_DIRTY',
  'CLEANING',
  'CLEANED',
  'INSPECTED',
  'READY',
  'OCCUPIED',
  'OUT_OF_ORDER',
  'BLOCKED',
] as const;

export type UnitStatusKey = (typeof UNIT_STATUS_KEYS)[number];

export interface UnitStatusTransition {
  to: UnitStatusKey;
  permission: PermissionKey;
  // 'manual': a human clicks a button for this — the API and the UI's
  // action-button list both read this table, per spec §7's "never
  // duplicate this logic." 'automatic': spec §7.1 states these happen as
  // a side effect of another module (inspection pass, booking check-in/
  // check-out) rather than a person choosing them directly — those
  // modules don't exist yet (M3/M4), so nothing calls these in M2, but
  // the transition itself is still valid and worth having in the table
  // now rather than duplicating it later. Until M3/M4 wire the real
  // triggers, an ALL-scoped `unit:manage` holder (SYSTEM_ADMIN,
  // RESORT_MANAGER) can still invoke one manually as a correction —
  // every transition needs *some* permission gate, never none.
  trigger: 'manual' | 'automatic';
}

// { from: transition[] }. Spec: "a map of { from -> allowed to[] } plus
// the permission required." Kept as an object of arrays (not from->to->x)
// so "what can this state become" is a single lookup, which is what both
// the API's validator and the UI's button list actually need.
export const UNIT_STATUS_TRANSITIONS: Record<UnitStatusKey, UnitStatusTransition[]> = {
  VACANT_DIRTY: [
    { to: 'CLEANING', permission: 'unit:update_status', trigger: 'manual' },
    { to: 'OUT_OF_ORDER', permission: 'unit:block', trigger: 'manual' },
    { to: 'BLOCKED', permission: 'unit:block', trigger: 'manual' },
  ],
  CLEANING: [
    { to: 'CLEANED', permission: 'unit:update_status', trigger: 'manual' },
    { to: 'OUT_OF_ORDER', permission: 'unit:block', trigger: 'manual' },
    { to: 'BLOCKED', permission: 'unit:block', trigger: 'manual' },
  ],
  CLEANED: [
    // Spec §7.1: "CLEANED -> INSPECTED requires workorder:verify — this
    // is the POC Housekeeping QC step."
    { to: 'INSPECTED', permission: 'workorder:verify', trigger: 'manual' },
    { to: 'OUT_OF_ORDER', permission: 'unit:block', trigger: 'manual' },
    { to: 'BLOCKED', permission: 'unit:block', trigger: 'manual' },
  ],
  INSPECTED: [
    // "INSPECTED -> READY is automatic on inspection pass." No
    // inspection module yet (M3) to call this automatically.
    { to: 'READY', permission: 'unit:manage', trigger: 'automatic' },
    { to: 'OUT_OF_ORDER', permission: 'unit:block', trigger: 'manual' },
    { to: 'BLOCKED', permission: 'unit:block', trigger: 'manual' },
  ],
  READY: [
    // "READY -> OCCUPIED happens automatically on booking check-in." No
    // booking module yet (M4) to call this automatically.
    { to: 'OCCUPIED', permission: 'unit:manage', trigger: 'automatic' },
    { to: 'OUT_OF_ORDER', permission: 'unit:block', trigger: 'manual' },
    { to: 'BLOCKED', permission: 'unit:block', trigger: 'manual' },
  ],
  OCCUPIED: [
    // "OCCUPIED -> VACANT_DIRTY happens automatically on check-out **and**
    // auto-creates a HOUSEKEEPING work order" — both the transition and
    // the auto-created ticket land with M4's check-out flow.
    { to: 'VACANT_DIRTY', permission: 'unit:manage', trigger: 'automatic' },
    { to: 'OUT_OF_ORDER', permission: 'unit:block', trigger: 'manual' },
  ],
  OUT_OF_ORDER: [{ to: 'VACANT_DIRTY', permission: 'unit:block', trigger: 'manual' }],
  BLOCKED: [{ to: 'VACANT_DIRTY', permission: 'unit:block', trigger: 'manual' }],
};

export function getTransition(from: UnitStatusKey, to: UnitStatusKey): UnitStatusTransition | undefined {
  return UNIT_STATUS_TRANSITIONS[from].find((t) => t.to === to);
}

export function canTransition(from: UnitStatusKey, to: UnitStatusKey): boolean {
  return getTransition(from, to) !== undefined;
}

// Manual transitions only, filtered to what `permissions` actually
// grants — exactly what a detail-drawer action-button list needs, and
// what the API's manual status-change endpoint accepts (automatic
// transitions are invoked by their owning module's service code
// directly, never through the generic manual endpoint, once M3/M4 build
// them).
export function allowedManualTransitions(
  from: UnitStatusKey,
  permissions: Partial<Record<PermissionKey, unknown>>,
): UnitStatusKey[] {
  return UNIT_STATUS_TRANSITIONS[from]
    .filter((t) => t.trigger === 'manual' && permissions[t.permission])
    .map((t) => t.to);
}
