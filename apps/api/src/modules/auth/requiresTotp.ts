import type { RoleKey } from '@lwwbr/shared';

// Spec §5.1: "Do not hardcode role names in business logic... all
// authorization checks are permission checks." This is a deliberate,
// narrow exception, not a violation of that rule by omission: TOTP
// enforcement isn't an authorization check (it doesn't gate access to a
// resource via requirePermission), it's an account-security *policy*
// that spec §3.1.1 states by name — "TOTP required for OWNER and
// SYSTEM_ADMIN" — for exactly the two roles that can see financials and
// change permissions, and are the ones most likely logging in from
// unfamiliar overseas networks. There is no permission key this maps to
// naturally, so it lives here instead: one small, explicit, commented
// list, not scattered role-name checks through the auth flow.
const ROLES_REQUIRING_TOTP: ReadonlySet<RoleKey> = new Set(['OWNER', 'SYSTEM_ADMIN']);

export function requiresTotp(roles: readonly RoleKey[]): boolean {
  return roles.some((role) => ROLES_REQUIRING_TOTP.has(role));
}
