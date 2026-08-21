// Permission keys per spec §5.3, format `resource:action`. Do not hardcode
// role names in business logic (spec §5.1) — every authorization check is
// a permission check against this list, never a role check.
export const PERMISSION_KEYS = [
  'user:read',
  'user:manage',
  'role:manage',
  'unit:read',
  'unit:update_status',
  'unit:manage',
  'unit:block',
  'unittype:manage',
  'booking:read',
  'booking:create',
  'booking:update',
  'booking:checkin',
  'booking:checkout',
  'payment:read',
  'payment:submit',
  'payment:verify',
  'folio:read',
  'folio:charge',
  'folio:settle',
  'folio:void',
  'workorder:read',
  'workorder:read_all',
  'workorder:create',
  'workorder:assign',
  'workorder:update_status',
  'workorder:verify',
  'workorder:close',
  'amenity:read',
  'amenity:request',
  'amenity:approve',
  'amenity:issue',
  'amenity:return',
  'amenity:manage',
  'fnb:read',
  'fnb:create',
  'fnb:update_status',
  'fnb:manage_menu',
  'inventory:read',
  'inventory:request',
  'inventory:adjust',
  'shift:read',
  'shift:manage',
  'restday:request',
  'restday:approve',
  'cash:read',
  'cash:record',
  'cash:verify',
  'incident:create',
  'incident:read',
  'inspection:submit',
  'inspection:read',
  'report:view',
  'report:export',
  'audit:read',
  'system:configure',
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];

// Scope on a role→permission grant per spec §5.4: ALL (property-wide),
// DEPARTMENT (scoped to the acting user's own User.department), or SELF
// (scoped to records the acting user created/owns). Mirrors the Prisma
// `RolePermissionScope` enum.
export const PERMISSION_SCOPES = ['ALL', 'DEPARTMENT', 'SELF'] as const;
export type PermissionScope = (typeof PERMISSION_SCOPES)[number];
