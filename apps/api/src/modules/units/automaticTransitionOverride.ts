import type { RoleKey } from '@lwwbr/shared';

// Spec §5.1: "Do not hardcode role names in business logic... all
// authorization checks are permission checks." Same deliberate, narrow
// exception as modules/auth/requiresTotp.ts, for the same reason: this
// isn't an authorization check against a resource (that's still
// `unit:manage`, checked separately) — it's a stopgap policy, scoped by
// client decision (2026-08-22) to SYSTEM_ADMIN only, not RESORT_MANAGER,
// even though both hold `unit:manage`. The three "automatic" unit-status
// transitions (INSPECTED->READY, READY->OCCUPIED, OCCUPIED->VACANT_DIRTY)
// have no real trigger yet — the inspection module (M3) and booking
// module (M4) that are supposed to call them don't exist — so a unit can
// otherwise get stuck with no way forward. This override exists to
// unstick one by hand until M3/M4 close the gap for real, and is
// deliberately not a normal operational path: RESORT_MANAGER runs the
// property day to day and using this as a habit would mask the
// inspection/booking flow never getting built. One small, explicit,
// commented list, not a permission any role is meant to hold routinely.
const ROLES_ALLOWED_TO_OVERRIDE_AUTOMATIC_TRANSITIONS: ReadonlySet<RoleKey> = new Set(['SYSTEM_ADMIN']);

export function canOverrideAutomaticTransition(roles: readonly RoleKey[]): boolean {
  return roles.some((role) => ROLES_ALLOWED_TO_OVERRIDE_AUTOMATIC_TRANSITIONS.has(role));
}
