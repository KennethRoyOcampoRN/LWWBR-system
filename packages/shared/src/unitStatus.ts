import type { PermissionKey } from './permissions.js';
import type { RoleKey } from './roles.js';

// Spec §7.1's unit status cycle, revised 2026-08-22 (client decision,
// operational correction — not a bug): the inspection step was dropped.
// At Lucky Waku-Waku the person who cleans a room's QC-inspects it and
// marks it ready in one motion; there is no separate handoff to a
// distinct inspector, so a standalone INSPECTED status between CLEANED
// and READY never reflected reality. Original 6-state cycle was:
//   VACANT_DIRTY -> CLEANING -> CLEANED -> INSPECTED -> READY -> OCCUPIED -> VACANT_DIRTY
// Current 5-state cycle:
//   VACANT_DIRTY -> CLEANING -> CLEANED -> READY -> OCCUPIED -> VACANT_DIRTY
// plus OUT_OF_ORDER / BLOCKED reachable from almost any state, both
// returning only to VACANT_DIRTY. See RETIRED_UNIT_STATUS_KEYS below for
// why INSPECTED still exists as a Prisma enum value and a TypeScript
// type even though it's no longer in this list.
export const UNIT_STATUS_KEYS = [
  'VACANT_DIRTY',
  'CLEANING',
  'CLEANED',
  'READY',
  'OCCUPIED',
  'OUT_OF_ORDER',
  'BLOCKED',
] as const;

export type UnitStatusKey = (typeof UNIT_STATUS_KEYS)[number];

// Historical-only: statuses that can never be entered again but may
// still appear in old data — Prisma's `UnitStatus` enum column can't
// have a value cleanly dropped once any row references it (Postgres has
// no "remove enum value" operation short of recreating the type), and
// more importantly a `UnitStatusEvent` row that says "this unit was
// INSPECTED at 9:44pm on 2026-08-21" is a true historical fact that must
// keep displaying correctly even after the status itself is retired —
// deleting or reinterpreting it would falsify the audit trail. Kept
// entirely separate from UNIT_STATUS_KEYS so no transition, dropdown, or
// validation path can ever produce INSPECTED again; display code (the
// timeline, and defensively the grid tile in case a live `Unit.status`
// row hasn't been corrected yet) is the only thing that should ever
// reference this.
export const RETIRED_UNIT_STATUS_KEYS = ['INSPECTED'] as const;
export type RetiredUnitStatusKey = (typeof RETIRED_UNIT_STATUS_KEYS)[number];

// Every value the Prisma `UnitStatus` enum column can actually contain,
// past or present — what display code should type against so a
// retired-status row (old event, or an unmigrated live unit) renders
// instead of crashing or showing `undefined`.
export const ALL_UNIT_STATUS_KEYS = [...UNIT_STATUS_KEYS, ...RETIRED_UNIT_STATUS_KEYS] as const;
export type AnyUnitStatusKey = UnitStatusKey | RetiredUnitStatusKey;

export interface UnitStatusTransition {
  to: UnitStatusKey;
  permission: PermissionKey;
  // 'manual': a human clicks a button for this — the API and the UI's
  // action-button list both read this table, per spec §7's "never
  // duplicate this logic." 'automatic': spec §7.1 states these happen as
  // a side effect of another module (booking check-in/check-out) rather
  // than a person choosing them directly — that module doesn't exist yet
  // (M4), so nothing calls these in M2, but the transition itself is
  // still valid and worth having in the table now rather than
  // duplicating it later. Until M4 wires the real trigger, an
  // ALL-scoped `unit:manage` holder (SYSTEM_ADMIN, RESORT_MANAGER) can
  // still invoke one manually as a correction — every transition needs
  // *some* permission gate, never none.
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
    // Revised 2026-08-22 (client decision): CLEANED -> READY is now a
    // normal manual transition — whoever holds the housekeeping
    // permission (`unit:update_status`, the same one that drives
    // VACANT_DIRTY->CLEANING and CLEANING->CLEANED) clicks it directly.
    // No separate QC step, no automatic-only gating: the person who
    // cleans the room is the same person who marks it ready, in one
    // motion. This used to be two hops (CLEANED -> INSPECTED via
    // workorder:verify, then an automatic-only INSPECTED -> READY) —
    // collapsing them removes one of the three transitions that used to
    // need the SYSTEM_ADMIN override below; only the two tied to M4's
    // booking flow still do.
    { to: 'READY', permission: 'unit:update_status', trigger: 'manual' },
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

// `from` is typed as UnitStatusKey (the forward-only 5 statuses), but
// these all take a defensive `?? []` fallback rather than a bare index:
// a live `Unit.status` row can still legitimately hold a retired value
// (INSPECTED) for as long as it takes someone to force-correct it after
// this deploy — `UNIT_STATUS_TRANSITIONS[retiredValue]` is `undefined`
// at runtime even though TypeScript can't see that from here, and the
// fallback is what keeps that a "no transitions available" state
// instead of a crash.
export function getTransition(from: UnitStatusKey, to: UnitStatusKey): UnitStatusTransition | undefined {
  return (UNIT_STATUS_TRANSITIONS[from] ?? []).find((t) => t.to === to);
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
  return (UNIT_STATUS_TRANSITIONS[from] ?? [])
    .filter((t) => t.trigger === 'manual' && permissions[t.permission])
    .map((t) => t.to);
}

// Spec §5.1: "Do not hardcode role names in business logic... all
// authorization checks are permission checks." Deliberate, narrow
// exception, same reasoning as requiresTotp.ts: this isn't a resource
// permission check (that's still `unit:manage`, enforced separately by
// the API) — it's a stopgap policy, scoped by client decision
// (2026-08-22) to SYSTEM_ADMIN only, not RESORT_MANAGER, even though
// both hold `unit:manage`. The two remaining "automatic" unit-status
// transitions (READY->OCCUPIED, OCCUPIED->VACANT_DIRTY — INSPECTED was
// retired the same day, see above, collapsing what used to be a third)
// have no real trigger yet — the booking module (M4) meant to call them
// doesn't exist — so without an escape hatch a unit can get permanently
// stuck. This lives here, not duplicated separately in apps/api and
// apps/web, so the API's enforcement and the UI's override button can
// never drift on "who is allowed to do this."
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
  return (UNIT_STATUS_TRANSITIONS[from] ?? []).filter((t) => t.trigger === 'automatic').map((t) => t.to);
}
