import { describe, expect, it } from 'vitest';
import { ROLE_KEYS } from '../src/roles.js';
import { PERMISSION_KEYS } from '../src/permissions.js';
import { ROLE_PERMISSIONS } from '../src/rolePermissions.js';
import { getEffectivePermissions, hasPermission } from '../src/authz.js';

describe('ROLE_PERMISSIONS', () => {
  it('only grants known permission keys', () => {
    const known = new Set(PERMISSION_KEYS);
    for (const role of ROLE_KEYS) {
      for (const key of Object.keys(ROLE_PERMISSIONS[role])) {
        expect(known.has(key as (typeof PERMISSION_KEYS)[number])).toBe(true);
      }
    }
  });

  // Spec §5.4: "OWNER is read-only across the entire system except
  // payment:verify and report:export. Enforce this at the API layer."
  it('grants OWNER only read-type keys plus payment:verify and report:export', () => {
    const writeKeys = Object.keys(ROLE_PERMISSIONS.OWNER).filter(
      (key) => key !== 'payment:verify' && key !== 'report:export' && !key.includes('read') && key !== 'report:view',
    );
    expect(writeKeys).toEqual([]);
  });

  // Spec §5.4: "Cashier cannot change room status or move work orders —
  // nothing operational."
  it('never grants CASHIER unit:update_status or any workorder action beyond create/read', () => {
    const perms = ROLE_PERMISSIONS.CASHIER;
    expect(perms['unit:update_status']).toBeUndefined();
    expect(perms['unit:block']).toBeUndefined();
    expect(perms['workorder:assign']).toBeUndefined();
    expect(perms['workorder:verify']).toBeUndefined();
    expect(perms['workorder:close']).toBeUndefined();
    expect(perms['workorder:update_status']).toBeUndefined();
  });

  // Spec §8.1 says the "+" quick action (report an issue) exists for
  // "every role," but the §5.4 matrix explicitly marks OWNER "—" on both
  // "workorder create" and "incident create" — consistent with the hard
  // "OWNER is read-only... except payment:verify and report:export"
  // rule. Flagging this as a spec tension rather than silently picking a
  // side: the matrix (more precise, reviewed row by row) wins here, so
  // OWNER is excluded. If the client confirms owners should be able to
  // report an issue too, that's a one-line change to rolePermissions.ts.
  it('every operational role can create a work order and report an incident', () => {
    for (const role of ROLE_KEYS) {
      if (role === 'OWNER') continue;
      expect(ROLE_PERMISSIONS[role]['workorder:create']).toBe('ALL');
      expect(ROLE_PERMISSIONS[role]['incident:create']).toBe('ALL');
    }
  });

  it('OWNER cannot create work orders or incidents, per the read-only-except rule', () => {
    expect(ROLE_PERMISSIONS.OWNER['workorder:create']).toBeUndefined();
    expect(ROLE_PERMISSIONS.OWNER['incident:create']).toBeUndefined();
  });

  it('scopes department-head workorder:read_all and report:view to DEPARTMENT', () => {
    for (const role of ['POC_HOUSEKEEPING', 'POC_MAINTENANCE', 'RESTAURANT_MANAGER'] as const) {
      expect(ROLE_PERMISSIONS[role]['workorder:read_all']).toBe('DEPARTMENT');
      expect(ROLE_PERMISSIONS[role]['report:view']).toBe('DEPARTMENT');
    }
  });
});

describe('getEffectivePermissions', () => {
  it('unions permissions across multiple roles', () => {
    const effective = getEffectivePermissions(['CASHIER', 'ADMIN_STAFF']);
    expect(hasPermission(effective, 'payment:submit')).toBe(true); // CASHIER
    expect(hasPermission(effective, 'booking:checkin')).toBe(true); // ADMIN_STAFF
  });

  it('widens scope to ALL when one role grants ALL and another grants DEPARTMENT for the same key', () => {
    const effective = getEffectivePermissions(['POC_HOUSEKEEPING', 'RESORT_MANAGER']);
    expect(effective['workorder:read_all']).toBe('ALL');
  });

  it('an unknown/empty role list yields no permissions', () => {
    const effective = getEffectivePermissions([]);
    expect(hasPermission(effective, 'unit:read')).toBe(false);
  });
});
