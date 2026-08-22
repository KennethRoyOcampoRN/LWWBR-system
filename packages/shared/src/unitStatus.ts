import type { PermissionKey } from './permissions.js';
import type { RoleKey } from './roles.js';

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
// grants — exactly what a detail-drawer action-button list needs for its
// normal, staff-facing buttons. Automatic transitions are handled
// separately below (allowedOverrideTransitions) since they need a role
// check, not a permission check, and render as a distinct "override" UI
// element, not an ordinary status button.
export function allowedManualTransitions(
  from: UnitStatusKey,
  permissions: Partial<Record<PermissionKey, unknown>>,
): UnitStatusKey[] {
  return UNIT_STATUS_TRANSITIONS[from]
    .filter((t) => t.trigger === 'manual' && permissions[t.permission])
    .map((t) => t.to);
}

// Spec §5.1: "Do not hardcode role names in business logic... all
// authorization checks are permission checks." Deliberate, narrow
// exception, same reasoning as requiresTotp.ts: this isn't a resource
// permission check (that's still `unit:manage`, enforced separately by
// the API) — it's a stopgap policy, scoped by client decision
// (2026-08-22) to SYSTEM_ADMIN only, not RESORT_MANAGER, even though
// both hold `unit:manage`. The three "automatic" unit-status transitions
// (INSPECTED->READY, READY->OCCUPIED, OCCUPIED->VACANT_DIRTY) have no
// real trigger yet — the inspection module (M3) and booking module (M4)
// meant to call them don't exist — so without an escape hatch a unit can
// get permanently stuck. This lives here, not duplicated separately in
// apps/api and apps/web, so the API's enforcement and the UI's override
// button can never drift on "who is allowed to do this."
const ROLES_ALLOWED_TO_OVERRIDE_AUTOMATIC_TRANSITIONS: ReadonlySet<RoleKey> = new Set(['SYSTEM_ADMIN']);

export function canOverrideAutomaticTransition(roles: readonly RoleKey[]): boolean {
  return roles.some((role) => ROLES_ALLOWED_TO_OVERRIDE_AUTOMATIC_TRANSITIONS.has(role));
}

// The automatic-only transitions from `from` that `roles` may invoke as
// a manual override — empty unless `roles` includes an allowed role.
// Distinct from allowedManualTransitions() so a caller (the detail
// drawer) can render these as a visually separate "admin override"
// control rather than an ordinary status button.
export function allowedOverrideTransitions(from: UnitStatusKey, roles: readonly RoleKey[]): UnitStatusKey[] {
  if (!canOverrideAutomaticTransition(roles)) return [];
  return UNIT_STATUS_TRANSITIONS[from].filter((t) => t.trigger === 'automatic').map((t) => t.to);
}
