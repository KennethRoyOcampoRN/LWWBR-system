import { ROLE_PERMISSIONS } from './rolePermissions.js';
import type { PermissionKey, PermissionScope } from './permissions.js';
import type { RoleKey } from './roles.js';

export type EffectivePermissions = Partial<Record<PermissionKey, PermissionScope>>;

// A user's effective permission set is the union of their roles' grants
// (spec §5.1). When two roles disagree on scope for the same key, the
// broader scope wins (ALL > DEPARTMENT > SELF) — a role granting
// property-wide access should not be narrowed by another role the same
// user also holds.
const SCOPE_RANK: Record<PermissionScope, number> = { SELF: 0, DEPARTMENT: 1, ALL: 2 };

export function getEffectivePermissions(roleKeys: readonly RoleKey[]): EffectivePermissions {
  const effective: EffectivePermissions = {};
  for (const roleKey of roleKeys) {
    const grants = ROLE_PERMISSIONS[roleKey];
    for (const [key, scope] of Object.entries(grants) as [PermissionKey, PermissionScope][]) {
      const existing = effective[key];
      if (!existing || SCOPE_RANK[scope] > SCOPE_RANK[existing]) {
        effective[key] = scope;
      }
    }
  }
  return effective;
}

export function hasPermission(effective: EffectivePermissions, key: PermissionKey): boolean {
  return effective[key] !== undefined;
}
