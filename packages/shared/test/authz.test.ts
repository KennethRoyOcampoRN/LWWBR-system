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
  // role has this" quick-action button. remittance:verify is a second,
  // later client-directed exception (2026-08-31): OWNER is the one role
  // that verifies (and can revert) a remittance, never creates one — see
  // rolePermissions.ts's own OWNER-block comment. No other write-shaped
  // key is ever granted to OWNER.
  const OWNER_ALLOWED_WRITE_KEYS = new Set([
    'payment:verify',
    'report:export',
    'workorder:create',
    'incident:create',
    'remittance:verify',
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

  // Real gap found 2026-08-31 (client-confirmed prose-vs-matrix
  // resolution, see the OWNER block's own comment in rolePermissions.ts):
  // §5.4's matrix marks OWNER "—" on every fnb row, contradicting the
  // spec's own "read-only across the entire system" prose. Read access
  // only — the three fnb write keys stay withheld.
  it('grants OWNER fnb:read but no fnb write access', () => {
    const perms = ROLE_PERMISSIONS.OWNER;
    expect(perms['fnb:read']).toBe('ALL');
    expect(perms['fnb:create']).toBeUndefined();
    expect(perms['fnb:manage_menu']).toBeUndefined();
    expect(perms['fnb:update_status']).toBeUndefined();
  });

  it('scopes department-head workorder:read_all and report:view to DEPARTMENT', () => {
    for (const role of ['POC_HOUSEKEEPING', 'POC_MAINTENANCE', 'RESTAURANT_MANAGER'] as const) {
      expect(ROLE_PERMISSIONS[role]['workorder:read_all']).toBe('DEPARTMENT');
      expect(ROLE_PERMISSIONS[role]['report:view']).toBe('DEPARTMENT');
    }
  });
});

// Client-directed feature, 2026-08-31: two standalone administrative
// request-and-status modules. Asserts the exact role/permission grid
// from the approved plan, not just "some role has it" — each of these
// role shapes is what the API/frontend test suites build their
// create/status-change permission-boundary fixtures from.
describe('remittance:*/quotation:* role grants', () => {
  const REMITTANCE_CREATORS = ['SYSTEM_ADMIN', 'RESORT_MANAGER', 'ADMIN_HEAD', 'ADMIN_STAFF'] as const;
  const REMITTANCE_VIEWERS = [...REMITTANCE_CREATORS, 'OWNER'] as const;
  const QUOTATION_CREATORS = ['RESORT_MANAGER', 'ADMIN_HEAD', 'ADMIN_STAFF'] as const;
  const QUOTATION_VIEWERS = [...QUOTATION_CREATORS, 'SYSTEM_ADMIN', 'OWNER'] as const;

  it('grants remittance:create to exactly the four named roles', () => {
    for (const role of REMITTANCE_CREATORS) {
      expect(ROLE_PERMISSIONS[role]['remittance:create']).toBe('ALL');
    }
    for (const role of ROLE_KEYS) {
      if (!REMITTANCE_CREATORS.includes(role as (typeof REMITTANCE_CREATORS)[number])) {
        expect(ROLE_PERMISSIONS[role]['remittance:create']).toBeUndefined();
      }
    }
  });

  it('grants remittance:read to the four creators plus OWNER, and remittance:verify to OWNER only', () => {
    for (const role of REMITTANCE_VIEWERS) {
      expect(ROLE_PERMISSIONS[role]['remittance:read']).toBe('ALL');
    }
    for (const role of ROLE_KEYS) {
      if (!REMITTANCE_VIEWERS.includes(role as (typeof REMITTANCE_VIEWERS)[number])) {
        expect(ROLE_PERMISSIONS[role]['remittance:read']).toBeUndefined();
      }
      if (role !== 'OWNER') {
        expect(ROLE_PERMISSIONS[role]['remittance:verify']).toBeUndefined();
      }
    }
    expect(ROLE_PERMISSIONS.OWNER['remittance:verify']).toBe('ALL');
  });

  it('grants quotation:create to exactly the three named roles — explicitly not SYSTEM_ADMIN', () => {
    for (const role of QUOTATION_CREATORS) {
      expect(ROLE_PERMISSIONS[role]['quotation:create']).toBe('ALL');
    }
    expect(ROLE_PERMISSIONS.SYSTEM_ADMIN['quotation:create']).toBeUndefined();
    for (const role of ROLE_KEYS) {
      if (!QUOTATION_CREATORS.includes(role as (typeof QUOTATION_CREATORS)[number])) {
        expect(ROLE_PERMISSIONS[role]['quotation:create']).toBeUndefined();
      }
    }
  });

  it('grants quotation:read to the three creators plus SYSTEM_ADMIN and OWNER, and quotation:update_status to SYSTEM_ADMIN only', () => {
    for (const role of QUOTATION_VIEWERS) {
      expect(ROLE_PERMISSIONS[role]['quotation:read']).toBe('ALL');
    }
    for (const role of ROLE_KEYS) {
      if (!QUOTATION_VIEWERS.includes(role as (typeof QUOTATION_VIEWERS)[number])) {
        expect(ROLE_PERMISSIONS[role]['quotation:read']).toBeUndefined();
      }
      if (role !== 'SYSTEM_ADMIN') {
        expect(ROLE_PERMISSIONS[role]['quotation:update_status']).toBeUndefined();
      }
    }
    expect(ROLE_PERMISSIONS.SYSTEM_ADMIN['quotation:update_status']).toBe('ALL');
  });
});

// Client-directed feature, 2026-08-31: stock monitoring and purchasing.
// Purely an assignable add-on role (STOCK_MANAGER) — asserts the exact
// grant, and specifically that no other role, including SYSTEM_ADMIN,
// carries any of the three stock:* keys by default (the client's own
// instruction, applied consistently rather than special-cased for
// SYSTEM_ADMIN — see STOCK_MANAGER's own comment in rolePermissions.ts).
describe('stock:* role grants', () => {
  const STOCK_KEYS = ['stock:read', 'stock:manage', 'stock:log_movement'] as const;

  it('grants all three stock:* keys to STOCK_MANAGER only', () => {
    for (const key of STOCK_KEYS) {
      expect(ROLE_PERMISSIONS.STOCK_MANAGER[key]).toBe('ALL');
    }
    for (const role of ROLE_KEYS) {
      if (role === 'STOCK_MANAGER') continue;
      for (const key of STOCK_KEYS) {
        expect(ROLE_PERMISSIONS[role][key]).toBeUndefined();
      }
    }
  });

  // The one place this is worth a dedicated assertion, not just folded
  // into the loop above: it's the one role someone might assume holds
  // every key by default (see the stale "SYSTEM_ADMIN keeps them, as it
  // does every key" line in this file's own header comment, which
  // predates this and the remittance/quotation exceptions).
  it('does not grant SYSTEM_ADMIN any stock:* key by default', () => {
    for (const key of STOCK_KEYS) {
      expect(ROLE_PERMISSIONS.SYSTEM_ADMIN[key]).toBeUndefined();
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
