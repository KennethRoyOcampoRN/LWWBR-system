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
  // Client-confirmed narrow exception on top of that (see header comment):
  // OWNER may also create work orders/incidents (report-only — it doesn't
  // grant assign/verify/close/update_status), matching §8.1's "every
  // role has this" quick-action button. No other write-shaped key is
  // ever granted to OWNER.
  const OWNER_ALLOWED_WRITE_KEYS = new Set([
    'payment:verify',
    'report:export',
    'workorder:create',
    'incident:create',
  ]);
  it('grants OWNER only read-type keys plus the confirmed narrow exceptions', () => {
    const writeKeys = Object.keys(ROLE_PERMISSIONS.OWNER).filter(
      (key) =>
        !OWNER_ALLOWED_WRITE_KEYS.has(key) && !key.includes('read') && key !== 'report:view',
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

  // Spec §8.1's "+" quick action (report an issue) exists for every role,
  // OWNER included — resolved per the client decision in the header
  // comment (report-only, doesn't touch assign/verify/close).
  it('every role can create a work order and report an incident', () => {
    for (const role of ROLE_KEYS) {
      expect(ROLE_PERMISSIONS[role]['workorder:create']).toBe('ALL');
      expect(ROLE_PERMISSIONS[role]['incident:create']).toBe('ALL');
    }
  });

  it("OWNER's work-order/incident access is create-only — no assign, verify, close, or update_status", () => {
    const perms = ROLE_PERMISSIONS.OWNER;
    expect(perms['workorder:assign']).toBeUndefined();
    expect(perms['workorder:verify']).toBeUndefined();
    expect(perms['workorder:close']).toBeUndefined();
    expect(perms['workorder:update_status']).toBeUndefined();
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
