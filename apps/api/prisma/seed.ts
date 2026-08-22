// M1 seed script (spec §10, §5.2-§5.4): idempotent — safe to run against a
// database that already has this data, via upsert on each unique key. Seeds
// permissions, roles, the role/permission matrix, and one placeholder demo
// user per role for local login testing.
//
// No real staff names anywhere (spec §12 rule 9) — every demo user's
// fullName is the role label itself, never a person.
import {
  PERMISSION_KEYS,
  ROLE_KEYS,
  ROLE_LABELS,
  ROLE_PERMISSIONS,
  type RoleKey,
} from '@lwwbr/shared';
import { PrismaClient, type Department } from '@prisma/client';
import { hashPassword } from '../src/modules/auth/passwords.js';

// Plain PrismaClient, not the audited one from src/lib/prisma.ts — seeding
// isn't a real request, there's no actor/ip/userAgent to attach, and this
// data isn't the kind of business-entity mutation spec §4.4's audit trail
// is for.
const prisma = new PrismaClient();

// Every permission key is `resource:action` (spec §5.3) — the group is the
// resource part, used to populate Permission.group for the future admin UI
// to organize the permission list by resource rather than as one flat list.
function groupOf(key: string): string {
  return key.split(':')[0] as string;
}

// Mirrors the Department enum's own doc comments in schema.prisma, mapping
// each of the 14 roles to the department its holder works in day to day.
// This is display/org data for the demo users the seed creates, not an
// authorization boundary — DEPARTMENT-scoped permission checks compare
// against User.department directly, unrelated to this mapping's existence.
const ROLE_DEPARTMENT: Record<RoleKey, Department> = {
  SYSTEM_ADMIN: 'MANAGEMENT',
  OWNER: 'MANAGEMENT',
  RESORT_MANAGER: 'MANAGEMENT',
  OPS_SAFETY_SUPERVISOR: 'MANAGEMENT',
  ADMIN_HEAD: 'FRONT_OFFICE',
  ADMIN_STAFF: 'FRONT_OFFICE',
  CASHIER: 'FRONT_OFFICE',
  POC_HOUSEKEEPING: 'HOUSEKEEPING',
  HOUSEKEEPING_STAFF: 'HOUSEKEEPING',
  POC_MAINTENANCE: 'MAINTENANCE',
  MAINTENANCE_STAFF: 'MAINTENANCE',
  RESORT_STAFF: 'GROUNDS_SAFETY',
  RESTAURANT_MANAGER: 'RESTAURANT',
  RESTAURANT_STAFF: 'RESTAURANT',
};

// Demo password for every seeded account — mustChangePassword forces a
// change on first login, so this being fixed and public in source isn't a
// standing credential.
const DEMO_PASSWORD = 'Waku2026!';

async function main() {
  console.warn(`Seeding ${PERMISSION_KEYS.length} permissions...`);
  for (const key of PERMISSION_KEYS) {
    await prisma.permission.upsert({
      where: { key },
      create: { key, group: groupOf(key) },
      update: { group: groupOf(key) },
    });
  }

  console.warn(`Seeding ${ROLE_KEYS.length} roles...`);
  for (const key of ROLE_KEYS) {
    await prisma.role.upsert({
      where: { key },
      create: { key, label: ROLE_LABELS[key], isSystem: true },
      update: { label: ROLE_LABELS[key], isSystem: true },
    });
  }

  console.warn('Seeding role/permission grants...');
  const allPermissions = await prisma.permission.findMany();
  const permissionIdByKey = new Map(allPermissions.map((p) => [p.key, p.id]));
  const allRoles = await prisma.role.findMany();
  const roleIdByKey = new Map(allRoles.map((r) => [r.key, r.id]));

  for (const roleKey of ROLE_KEYS) {
    const roleId = roleIdByKey.get(roleKey);
    if (!roleId) throw new Error(`Role ${roleKey} was not seeded`);

    const grants = ROLE_PERMISSIONS[roleKey];
    for (const [permissionKey, scope] of Object.entries(grants)) {
      const permissionId = permissionIdByKey.get(permissionKey);
      if (!permissionId) throw new Error(`Permission ${permissionKey} was not seeded`);

      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId, permissionId } },
        create: { roleId, permissionId, scope },
        update: { scope },
      });
    }
  }

  console.warn(`Seeding ${ROLE_KEYS.length} demo users (one per role)...`);
  const passwordHash = await hashPassword(DEMO_PASSWORD);

  for (const [index, roleKey] of ROLE_KEYS.entries()) {
    const employeeCode = `LWW-${String(index + 1).padStart(3, '0')}`;
    const roleId = roleIdByKey.get(roleKey);
    if (!roleId) throw new Error(`Role ${roleKey} was not seeded`);

    const user = await prisma.user.upsert({
      where: { employeeCode },
      create: {
        employeeCode,
        fullName: `${ROLE_LABELS[roleKey]} (Demo)`,
        passwordHash,
        department: ROLE_DEPARTMENT[roleKey],
        mustChangePassword: true,
      },
      update: {
        fullName: `${ROLE_LABELS[roleKey]} (Demo)`,
        department: ROLE_DEPARTMENT[roleKey],
      },
    });

    // Each demo account is meant to hold EXACTLY its one intended role,
    // for the nav-filtering and TOTP-gating checks to mean anything.
    // Delete any other role assignment before upserting the intended
    // one — a plain upsert only ever adds, so a stray UserRole row from
    // an earlier seed run, an earlier bug, or manual testing via the
    // Users admin UI would silently persist forever otherwise (and
    // requiresTotp()'s `.some()` check is a real security feature, not
    // a bug, when it does that — any role union that includes
    // SYSTEM_ADMIN correctly requires TOTP, stray or not).
    await prisma.userRole.deleteMany({ where: { userId: user.id, roleId: { not: roleId } } });
    await prisma.userRole.upsert({
      where: { userId_roleId: { userId: user.id, roleId } },
      create: { userId: user.id, roleId },
      update: {},
    });
  }

  console.warn('Verifying final role assignments...');
  const demoUsers = await prisma.user.findMany({
    where: { employeeCode: { startsWith: 'LWW-' } },
    include: { roles: { where: { deletedAt: null }, include: { role: true } } },
    orderBy: { employeeCode: 'asc' },
  });
  for (const user of demoUsers) {
    const roleKeys = user.roles.map((userRole) => userRole.role.key);
    const flag = roleKeys.length === 1 ? '' : '  <-- expected exactly 1 role';
    console.warn(`  ${user.employeeCode}: [${roleKeys.join(', ')}]${flag}`);
  }

  console.warn('Seed complete.');
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
