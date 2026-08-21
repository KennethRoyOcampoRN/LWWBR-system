// Seeded roles per spec §5.2. Roles are positions, not people — no
// individual's name appears here (spec §12 rule 9). Editable by
// SYSTEM_ADMIN at runtime through the Role/Permission/RolePermission
// tables; this list is what apps/api/prisma/seed.ts seeds them from.

export const ROLE_KEYS = [
  'SYSTEM_ADMIN',
  'OWNER',
  'RESORT_MANAGER',
  'OPS_SAFETY_SUPERVISOR',
  'ADMIN_HEAD',
  'ADMIN_STAFF',
  'CASHIER',
  'POC_HOUSEKEEPING',
  'HOUSEKEEPING_STAFF',
  'POC_MAINTENANCE',
  'MAINTENANCE_STAFF',
  'RESORT_STAFF',
  'RESTAURANT_MANAGER',
  'RESTAURANT_STAFF',
] as const;

export type RoleKey = (typeof ROLE_KEYS)[number];

export const ROLE_LABELS: Record<RoleKey, string> = {
  SYSTEM_ADMIN: 'Marketing Manager / System Admin',
  OWNER: 'Owner',
  RESORT_MANAGER: 'Resort Manager / Operations Head',
  OPS_SAFETY_SUPERVISOR: 'Operations & Safety Supervisor',
  ADMIN_HEAD: 'Admin Head',
  ADMIN_STAFF: 'Admin Staff',
  CASHIER: 'Cashier',
  POC_HOUSEKEEPING: 'POC Housekeeping',
  HOUSEKEEPING_STAFF: 'Room Attendant',
  POC_MAINTENANCE: 'POC Maintenance & Facilities',
  MAINTENANCE_STAFF: 'Maintenance Technician',
  RESORT_STAFF: 'Resort Staff',
  RESTAURANT_MANAGER: 'Restaurant Manager',
  RESTAURANT_STAFF: 'Restaurant Staff',
};
