import type { PermissionKey, PermissionScope } from './permissions.js';
import type { RoleKey } from './roles.js';

// Seed values for the role→permission matrix, spec §5.4. Mechanically
// derived from the §5.4 table in spec.md (parsed directly from the file,
// not retyped by hand, to eliminate transcription error on a 14-role by
// 35-row grid) plus a documented set of additions for permission keys that
// have no dedicated matrix row (see below).
//
// Two deliberate departures from a literal reading of the table:
//
// 1. OWNER and 👁 on a write-shaped row. The table marks OWNER 👁 on "cash
//    verify" and "shift manage", both mutating actions. Taken literally
//    that would grant OWNER the actual cash:verify/shift:manage
//    permissions — but spec §5.4 states explicitly: "OWNER is read-only
//    across the entire system except payment:verify and report:export...
//    Enforce this at the API layer." The prose rule is authoritative:
//    OWNER does NOT get cash:verify or shift:manage. The same "👁 on a
//    write row = no grant" reading is applied to "fnb update_status" for
//    RESORT_MANAGER/ADMIN_HEAD/ADMIN_STAFF/CASHIER (all 👁 there) for
//    consistency with the legend's own definition of 👁 as "read-only
//    variant" — those roles can see the kitchen board (fnb:read, granted
//    via the "fnb create order" row) but don't drag tickets through it;
//    that's Restaurant Manager/Staff's job (✅ on that row).
//
// 2. Permission keys with no matrix row at all: workorder:read (distinct
//    from workorder:read_all in §5.3's key list — granted to every role,
//    since everyone can create a ticket and "My tasks" views need to read
//    at least your own), payment:read/cash:read/inventory:read (granted
//    to whichever roles already hold the corresponding submit/verify/
//    record/adjust/request permission — you need to see the queue to act
//    on it), shift:read (granted to every role — everyone needs to see
//    their own roster even though only a subset can edit it),
//    amenity:read/amenity:approve/amenity:manage, fnb:read,
//    inspection:submit/inspection:read, incident:read, restday:request,
//    system:configure. Each is a reasoned inference consistent with the
//    matrix's other patterns, not an arbitrary default — see the
//    scaffold-generation script referenced in the M1 commit for the exact
//    per-key reasoning if this ever needs revisiting.
//
// Resolved ambiguity (client decision, not a default): the table marks
// OWNER "—" on both workorder:create and incident:create, in tension with
// spec §8.1's "every role" has the "+" report-an-issue button. The client
// confirmed OWNER should have the button — report-only, since creating a
// ticket doesn't let OWNER assign, verify, or close anything, so it's a
// narrow exception rather than a breach of "read-only except
// payment:verify and report:export." OWNER is granted workorder:create
// and incident:create below; every other write-shaped key stays withheld.
//
// 3. booking:checkin/booking:checkout narrowed below the table (client
//    decision, 2026-08-24): §5.4's row grants these to SYS_ADMIN,
//    RESORT_MGR, OPS_SAFETY, ADMIN_HEAD, ADMIN_STAFF, and CASHIER. The
//    client's own instruction while redesigning the check-in/check-out
//    flow was explicit and narrower — "seed booking:checkin and
//    booking:checkout to RESORT_MANAGER, ADMIN_HEAD, and ADMIN_STAFF by
//    default" — so OPS_SAFETY_SUPERVISOR and CASHIER no longer carry
//    these two keys in the seed (SYSTEM_ADMIN keeps them, as it does
//    every key). Not a permanent ceiling: SYSTEM_ADMIN can grant either
//    key to any other role afterward via the Roles admin page — this is
//    only the seed default, same as every other role/permission decision
//    made this session.
//
// 4. booking:read/booking:create/booking:update dropped entirely,
//    2026-08-24: the reservation-creation redesign (see booking.ts's own
//    header comment) removed every route these three ever gated —
//    booking:create's only route/nav item, and booking:read's only two
//    routes (search, get-by-id). booking:update never had a route to
//    begin with, even before this change. No grants for any of the
//    three below; PERMISSION_KEYS itself no longer lists them.
export const ROLE_PERMISSIONS: Record<RoleKey, Partial<Record<PermissionKey, PermissionScope>>> = {
  SYSTEM_ADMIN: {
    'amenity:approve': 'ALL',
    'amenity:issue': 'ALL',
    'amenity:manage': 'ALL',
    'amenity:read': 'ALL',
    'amenity:request': 'ALL',
    'amenity:return': 'ALL',
    'audit:read': 'ALL',
    'booking:checkin': 'ALL',
    'booking:checkout': 'ALL',
    'cash:read': 'ALL',
    'cash:record': 'ALL',
    'cash:verify': 'ALL',
    'fnb:create': 'ALL',
    'fnb:manage_menu': 'ALL',
    'fnb:read': 'ALL',
    'fnb:update_status': 'ALL',
    'folio:charge': 'ALL',
    'folio:read': 'ALL',
    'folio:settle': 'ALL',
    'folio:void': 'ALL',
    'incident:create': 'ALL',
    'incident:read': 'ALL',
    'inspection:read': 'ALL',
    'inspection:submit': 'ALL',
    'inventory:adjust': 'ALL',
    'inventory:read': 'ALL',
    'inventory:request': 'ALL',
    'payment:read': 'ALL',
    'payment:submit': 'ALL',
    'payment:verify': 'ALL',
    // Client-directed feature, 2026-08-31: remittance:*/quotation:* —
    // see permissions.ts for why these aren't payment:*/booking:*.
    // remittance:create is one of SYSTEM_ADMIN's four named creator
    // roles (Admin Head/Resort Manager/System Admin/Admin Staff);
    // quotation:create deliberately is NOT — System Admin is the one
    // role that can mark a quotation Done/Pending, so it can see and
    // resolve every quotation without also being able to create one.
    'quotation:read': 'ALL',
    'quotation:update_status': 'ALL',
    'remittance:create': 'ALL',
    'remittance:read': 'ALL',
    'report:export': 'ALL',
    'report:view': 'ALL',
    'restday:approve': 'ALL',
    'restday:request': 'ALL',
    'role:manage': 'ALL',
    'shift:manage': 'ALL',
    'shift:read': 'ALL',
    'system:configure': 'ALL',
    'unit:block': 'ALL',
    'unit:force_status': 'ALL', // client decision, 2026-08-22 — see permissions.ts's comment; SYSTEM_ADMIN only for now
    'unit:manage': 'ALL',
    'unit:read': 'ALL',
    'unit:update_status': 'ALL',
    'unittype:manage': 'ALL',
    'user:manage': 'ALL',
    'user:read': 'ALL',
    'workorder:assign': 'ALL',
    'workorder:close': 'ALL',
    'workorder:create': 'ALL',
    'workorder:read': 'ALL',
    'workorder:read_all': 'ALL',
    'workorder:update_status': 'ALL',
    'workorder:verify': 'ALL',
  },
  OWNER: {
    'audit:read': 'ALL',
    'cash:read': 'ALL',
    // Real gap found scoping the Command Center KPI-card-navigation
    // slice, 2026-08-31: OWNER held zero fnb:* keys at all — couldn't
    // even see the Restaurant nav item or page. The matrix's own §5.4
    // fnb rows mark OWNER "—" (not even 👁) on all three, so this isn't
    // a misreading of the table; it's a genuine conflict with spec's own
    // prose a few lines above it: "OWNER is read-only across the entire
    // system except payment:verify and report:export." A role that's
    // supposed to be read-only *everywhere* being fully blocked from one
    // entire module contradicts that sentence outright — same kind of
    // prose-vs-matrix tension already resolved elsewhere in this file
    // (see the workorder:create/incident:create note above), and
    // resolved the same way: the prose is authoritative. Read-only only
    // — fnb:create/fnb:manage_menu/fnb:update_status stay withheld, so
    // OWNER still can't place orders, edit the menu, or drag a ticket
    // through the kitchen board.
    'fnb:read': 'ALL',
    'folio:read': 'ALL',
    'incident:create': 'ALL', // resolved ambiguity — see header comment
    'incident:read': 'ALL',
    'payment:read': 'ALL',
    'payment:verify': 'ALL',
    // Client-directed feature, 2026-08-31: OWNER verifies (and can
    // revert) a remittance, so it needs read + verify but never create
    // — OWNER never submits its own remittance for its own verification.
    // Quotation is read-only for OWNER; System Admin owns marking Done/
    // Pending.
    'quotation:read': 'ALL',
    'remittance:read': 'ALL',
    'remittance:verify': 'ALL',
    'report:export': 'ALL',
    'report:view': 'ALL',
    'shift:read': 'ALL',
    'unit:read': 'ALL',
    'workorder:create': 'ALL', // resolved ambiguity — see header comment
    'workorder:read': 'ALL',
    'workorder:read_all': 'ALL',
  },
  RESORT_MANAGER: {
    'amenity:approve': 'ALL',
    'amenity:issue': 'ALL',
    'amenity:manage': 'ALL',
    'amenity:read': 'ALL',
    'amenity:request': 'ALL',
    'amenity:return': 'ALL',
    'audit:read': 'ALL',
    'booking:checkin': 'ALL',
    'booking:checkout': 'ALL',
    'cash:read': 'ALL',
    'cash:record': 'ALL',
    'cash:verify': 'ALL',
    'fnb:create': 'ALL',
    'fnb:manage_menu': 'ALL',
    'fnb:read': 'ALL',
    'folio:charge': 'ALL',
    'folio:read': 'ALL',
    'folio:settle': 'ALL',
    'folio:void': 'ALL',
    'incident:create': 'ALL',
    'incident:read': 'ALL',
    'inspection:read': 'ALL',
    'inspection:submit': 'ALL',
    'inventory:adjust': 'ALL',
    'inventory:read': 'ALL',
    'inventory:request': 'ALL',
    'payment:read': 'ALL',
    'payment:submit': 'ALL',
    'payment:verify': 'ALL',
    // Client-directed feature, 2026-08-31 — see permissions.ts's
    // remittance:*/quotation:* comment.
    'quotation:create': 'ALL',
    'quotation:read': 'ALL',
    'remittance:create': 'ALL',
    'remittance:read': 'ALL',
    'report:export': 'ALL',
    'report:view': 'ALL',
    'restday:approve': 'ALL',
    'restday:request': 'ALL',
    'shift:manage': 'ALL',
    'shift:read': 'ALL',
    'unit:block': 'ALL',
    'unit:manage': 'ALL',
    'unit:read': 'ALL',
    'unit:update_status': 'ALL',
    'unittype:manage': 'ALL',
    'user:read': 'ALL',
    'workorder:assign': 'ALL',
    'workorder:close': 'ALL',
    'workorder:create': 'ALL',
    'workorder:read': 'ALL',
    'workorder:read_all': 'ALL',
    'workorder:update_status': 'ALL',
    'workorder:verify': 'ALL',
  },
  OPS_SAFETY_SUPERVISOR: {
    'amenity:approve': 'ALL',
    'amenity:issue': 'ALL',
    'amenity:read': 'ALL',
    'amenity:request': 'ALL',
    'amenity:return': 'ALL',
    'cash:read': 'ALL',
    'cash:record': 'ALL',
    'cash:verify': 'ALL',
    'folio:read': 'ALL',
    'folio:void': 'ALL',
    'incident:create': 'ALL',
    'incident:read': 'ALL',
    'inspection:read': 'ALL',
    'inspection:submit': 'ALL',
    'inventory:adjust': 'ALL',
    'inventory:read': 'ALL',
    'inventory:request': 'ALL',
    'report:export': 'ALL',
    'report:view': 'ALL',
    'restday:approve': 'ALL',
    'restday:request': 'ALL',
    'shift:manage': 'ALL',
    'shift:read': 'ALL',
    'unit:block': 'ALL',
    'unit:read': 'ALL',
    'unit:update_status': 'ALL',
    'workorder:assign': 'ALL',
    'workorder:close': 'ALL',
    'workorder:create': 'ALL',
    'workorder:read': 'ALL',
    'workorder:read_all': 'ALL',
    'workorder:update_status': 'ALL',
    'workorder:verify': 'ALL',
  },
  ADMIN_HEAD: {
    'amenity:approve': 'ALL',
    'amenity:issue': 'ALL',
    'amenity:read': 'ALL',
    'amenity:request': 'ALL',
    'amenity:return': 'ALL',
    'booking:checkin': 'ALL',
    'booking:checkout': 'ALL',
    'cash:read': 'ALL',
    'cash:record': 'ALL',
    'fnb:create': 'ALL',
    'fnb:read': 'ALL',
    'folio:charge': 'ALL',
    'folio:read': 'ALL',
    'folio:settle': 'ALL',
    'incident:create': 'ALL',
    'incident:read': 'ALL',
    'inventory:read': 'ALL',
    'inventory:request': 'ALL',
    'payment:read': 'ALL',
    'payment:submit': 'ALL',
    'payment:verify': 'ALL',
    // Client-directed feature, 2026-08-31 — see permissions.ts's
    // remittance:*/quotation:* comment.
    'quotation:create': 'ALL',
    'quotation:read': 'ALL',
    'remittance:create': 'ALL',
    'remittance:read': 'ALL',
    'report:export': 'ALL',
    'report:view': 'ALL',
    'restday:request': 'ALL',
    'shift:manage': 'ALL',
    'shift:read': 'ALL',
    'unit:read': 'ALL',
    'unit:update_status': 'ALL',
    'workorder:create': 'ALL',
    'workorder:read': 'ALL',
    'workorder:read_all': 'ALL',
    'workorder:update_status': 'ALL',
  },
  ADMIN_STAFF: {
    'amenity:approve': 'ALL',
    'amenity:issue': 'ALL',
    'amenity:read': 'ALL',
    'amenity:request': 'ALL',
    'amenity:return': 'ALL',
    'booking:checkin': 'ALL',
    'booking:checkout': 'ALL',
    'fnb:create': 'ALL',
    'fnb:read': 'ALL',
    'folio:charge': 'ALL',
    'folio:read': 'ALL',
    'incident:create': 'ALL',
    'payment:read': 'ALL',
    'payment:submit': 'ALL',
    // Client-directed feature, 2026-08-31 — see permissions.ts's
    // remittance:*/quotation:* comment.
    'quotation:create': 'ALL',
    'quotation:read': 'ALL',
    'remittance:create': 'ALL',
    'remittance:read': 'ALL',
    'restday:request': 'ALL',
    'shift:read': 'ALL',
    'unit:read': 'ALL',
    'unit:update_status': 'ALL',
    'workorder:create': 'ALL',
    'workorder:read': 'ALL',
    'workorder:update_status': 'ALL',
  },
  CASHIER: {
    'amenity:approve': 'ALL',
    'amenity:issue': 'ALL',
    'amenity:read': 'ALL',
    'amenity:request': 'ALL',
    'amenity:return': 'ALL',
    'cash:read': 'ALL',
    'cash:record': 'ALL',
    'fnb:create': 'ALL',
    'fnb:read': 'ALL',
    'folio:charge': 'ALL',
    'folio:read': 'ALL',
    'folio:settle': 'ALL',
    'incident:create': 'ALL',
    'payment:read': 'ALL',
    'payment:submit': 'ALL',
    'report:view': 'ALL',
    'restday:request': 'ALL',
    'shift:read': 'ALL',
    'unit:read': 'ALL',
    'workorder:create': 'ALL',
    'workorder:read': 'ALL',
  },
  POC_HOUSEKEEPING: {
    'amenity:approve': 'ALL',
    'amenity:issue': 'ALL',
    'amenity:read': 'ALL',
    'amenity:request': 'ALL',
    'amenity:return': 'ALL',
    'incident:create': 'ALL',
    'inspection:read': 'ALL',
    'inspection:submit': 'ALL',
    'inventory:adjust': 'ALL',
    'inventory:read': 'ALL',
    'inventory:request': 'ALL',
    'report:view': 'DEPARTMENT',
    'restday:request': 'ALL',
    'shift:manage': 'ALL',
    'shift:read': 'ALL',
    'unit:block': 'ALL',
    'unit:read': 'ALL',
    'unit:update_status': 'ALL',
    'workorder:assign': 'ALL',
    'workorder:close': 'ALL',
    'workorder:create': 'ALL',
    'workorder:read': 'ALL',
    'workorder:read_all': 'DEPARTMENT',
    'workorder:update_status': 'ALL',
    'workorder:verify': 'ALL',
  },
  HOUSEKEEPING_STAFF: {
    'amenity:approve': 'ALL',
    'amenity:issue': 'ALL',
    'amenity:read': 'ALL',
    'amenity:return': 'ALL',
    'incident:create': 'ALL',
    'restday:request': 'ALL',
    'shift:read': 'ALL',
    'unit:read': 'ALL',
    'unit:update_status': 'ALL',
    'workorder:create': 'ALL',
    'workorder:read': 'ALL',
    'workorder:update_status': 'ALL',
  },
  POC_MAINTENANCE: {
    'incident:create': 'ALL',
    'inspection:read': 'ALL',
    'inspection:submit': 'ALL',
    'inventory:adjust': 'ALL',
    'inventory:read': 'ALL',
    'inventory:request': 'ALL',
    'report:view': 'DEPARTMENT',
    'restday:request': 'ALL',
    'shift:manage': 'ALL',
    'shift:read': 'ALL',
    'unit:block': 'ALL',
    'unit:read': 'ALL',
    'unit:update_status': 'ALL',
    'workorder:assign': 'ALL',
    'workorder:close': 'ALL',
    'workorder:create': 'ALL',
    'workorder:read': 'ALL',
    'workorder:read_all': 'DEPARTMENT',
    'workorder:update_status': 'ALL',
    'workorder:verify': 'ALL',
  },
  MAINTENANCE_STAFF: {
    'incident:create': 'ALL',
    'restday:request': 'ALL',
    'shift:read': 'ALL',
    'unit:read': 'ALL',
    'unit:update_status': 'ALL',
    'workorder:create': 'ALL',
    'workorder:read': 'ALL',
    'workorder:update_status': 'ALL',
  },
  RESORT_STAFF: {
    'amenity:approve': 'ALL',
    'amenity:issue': 'ALL',
    'amenity:read': 'ALL',
    'amenity:request': 'ALL',
    'amenity:return': 'ALL',
    'incident:create': 'ALL',
    'restday:request': 'ALL',
    'shift:read': 'ALL',
    'unit:read': 'ALL',
    'workorder:create': 'ALL',
    'workorder:read': 'ALL',
    'workorder:update_status': 'ALL',
  },
  RESTAURANT_MANAGER: {
    'cash:read': 'ALL',
    'cash:record': 'ALL',
    'fnb:create': 'ALL',
    'fnb:manage_menu': 'ALL',
    'fnb:read': 'ALL',
    'fnb:update_status': 'ALL',
    'folio:charge': 'ALL',
    'folio:read': 'ALL',
    'incident:create': 'ALL',
    'inventory:adjust': 'ALL',
    'inventory:read': 'ALL',
    'inventory:request': 'ALL',
    'report:export': 'ALL',
    'report:view': 'DEPARTMENT',
    'restday:request': 'ALL',
    'shift:manage': 'ALL',
    'shift:read': 'ALL',
    'unit:read': 'ALL',
    'workorder:assign': 'ALL',
    'workorder:close': 'ALL',
    'workorder:create': 'ALL',
    'workorder:read': 'ALL',
    'workorder:read_all': 'DEPARTMENT',
    'workorder:update_status': 'ALL',
    'workorder:verify': 'ALL',
  },
  RESTAURANT_STAFF: {
    'fnb:create': 'ALL',
    'fnb:read': 'ALL',
    'fnb:update_status': 'ALL',
    'folio:charge': 'ALL',
    'incident:create': 'ALL',
    'inventory:read': 'ALL',
    'inventory:request': 'ALL',
    'restday:request': 'ALL',
    'shift:read': 'ALL',
    'workorder:create': 'ALL',
    'workorder:read': 'ALL',
    'workorder:update_status': 'ALL',
  },
};

