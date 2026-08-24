// M1 seed script (spec §10, §5.2-§5.4): idempotent — safe to run against a
// database that already has this data, via upsert on each unique key. Seeds
// permissions, roles, the role/permission matrix, and one placeholder demo
// user per role for local login testing.
//
// No real staff names anywhere (spec §12 rule 9) — every demo user's
// fullName is the role label itself, never a person.
import {
  DEFAULT_WORK_ORDER_PHOTO_REQUIREMENTS,
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

// Spec §10: unit types with PLACEHOLDER rates — "the client will create
// and price the real ones through the admin UI." `key` is this script's
// own idempotency key (UnitType has no natural unique column beyond id),
// not a spec-defined field.
const UNIT_TYPE_SEEDS = [
  { key: 'standard-room', name: 'Standard Room', defaultCapacity: 2, baseRate: 1500 },
  { key: 'family-room', name: 'Family Room', defaultCapacity: 4, baseRate: 2500 },
  { key: 'day-tour-cottage', name: 'Day Tour Cottage', defaultCapacity: 6, baseRate: 1800, dayTourRate: 1200 },
  // Not itself a spec §10 line item, but Unit.unitTypeId is required
  // (not nullable) and the 7 common areas below need somewhere to point
  // — a zero-rate placeholder type keeps them out of Standard/Family/
  // Cottage's real pricing rather than forcing a fake room rate onto a
  // restroom.
  { key: 'common-area', name: 'Common Area', defaultCapacity: 0, baseRate: 0 },
] as const;

// Spec §10: "13 rooms R01-R13 and 3 cottages C01-C03 as placeholder units
// with placeholder names and capacities... Make sure the unit management
// screen supports rename/re-code/capacity change/type reassignment/
// reordering, because everything seeded here will be replaced on day
// one." capacity is left unset here so it falls back to the unit type's
// defaultCapacity, same as the admin-UI create-unit flow does.
const ROOM_UNIT_SEEDS = Array.from({ length: 13 }, (_, i) => ({
  code: `R${String(i + 1).padStart(2, '0')}`,
  name: `Room ${i + 1}`,
  unitTypeKey: 'standard-room' as const,
  type: 'ROOM' as const,
}));
const COTTAGE_UNIT_SEEDS = Array.from({ length: 3 }, (_, i) => ({
  code: `C${String(i + 1).padStart(2, '0')}`,
  name: `Cottage ${i + 1}`,
  unitTypeKey: 'day-tour-cottage' as const,
  type: 'COTTAGE' as const,
}));
// Spec §10: "Common areas: Pool, Beach Front, Open Field, CR-Male,
// CR-Female, Function Hall, Restaurant."
const COMMON_AREA_UNIT_SEEDS = [
  { code: 'POOL', name: 'Pool' },
  { code: 'BEACH', name: 'Beach Front' },
  { code: 'FIELD', name: 'Open Field' },
  { code: 'CR-M', name: 'CR - Male' },
  { code: 'CR-F', name: 'CR - Female' },
  { code: 'HALL', name: 'Function Hall' },
  { code: 'RESTO', name: 'Restaurant' },
].map((seed) => ({ ...seed, unitTypeKey: 'common-area' as const, type: 'COMMON_AREA' as const }));

// Spec §10: "~12 amenity items: PS4/PS5 console, videoke unit ×2, 6 board
// games, beach volleyball set, kayak, billiard table." depositAmount is
// seeded as a plain informational figure (how much staff should
// physically collect) — this app doesn't track payments, so it's never
// posted anywhere or reconciled against a Payment row.
const AMENITY_ITEM_SEEDS = [
  { name: 'PS4 Console', category: 'CONSOLE' as const, totalQty: 1, requiresDeposit: true, depositAmount: 500 },
  { name: 'PS5 Console', category: 'CONSOLE' as const, totalQty: 1, requiresDeposit: true, depositAmount: 500 },
  { name: 'Videoke Unit 1', category: 'VIDEOKE' as const, totalQty: 1, requiresDeposit: true, depositAmount: 300 },
  { name: 'Videoke Unit 2', category: 'VIDEOKE' as const, totalQty: 1, requiresDeposit: true, depositAmount: 300 },
  { name: 'Monopoly', category: 'BOARD_GAME' as const, totalQty: 1, requiresDeposit: false, depositAmount: 0 },
  { name: 'Uno', category: 'BOARD_GAME' as const, totalQty: 2, requiresDeposit: false, depositAmount: 0 },
  { name: 'Scrabble', category: 'BOARD_GAME' as const, totalQty: 1, requiresDeposit: false, depositAmount: 0 },
  { name: 'Chess Set', category: 'BOARD_GAME' as const, totalQty: 2, requiresDeposit: false, depositAmount: 0 },
  { name: 'Jenga', category: 'BOARD_GAME' as const, totalQty: 1, requiresDeposit: false, depositAmount: 0 },
  { name: 'Connect Four', category: 'BOARD_GAME' as const, totalQty: 1, requiresDeposit: false, depositAmount: 0 },
  { name: 'Beach Volleyball Set', category: 'OUTDOOR' as const, totalQty: 1, requiresDeposit: false, depositAmount: 0 },
  { name: 'Kayak', category: 'OUTDOOR' as const, totalQty: 2, requiresDeposit: true, depositAmount: 1000 },
  { name: 'Billiard Table', category: 'OTHER' as const, totalQty: 1, requiresDeposit: false, depositAmount: 0 },
];

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

  console.warn(`Seeding ${UNIT_TYPE_SEEDS.length} unit types...`);
  // UnitType has no natural unique column (only `id`, generated), so this
  // is a manual find-then-create rather than a true prisma .upsert() —
  // `name` is this seed's own idempotency key. Create-if-missing only,
  // same reasoning as the units below: spec §10 says the client prices
  // these for real through the admin UI, so a re-run must not overwrite
  // that real pricing back to the seed's placeholder rates.
  const unitTypeIdByKey = new Map<string, string>();
  for (const seed of UNIT_TYPE_SEEDS) {
    const existing = await prisma.unitType.findFirst({ where: { name: seed.name } });
    const unitType =
      existing ??
      (await prisma.unitType.create({
        data: {
          name: seed.name,
          defaultCapacity: seed.defaultCapacity,
          baseRate: seed.baseRate,
          dayTourRate: 'dayTourRate' in seed ? seed.dayTourRate : null,
        },
      }));
    unitTypeIdByKey.set(seed.key, unitType.id);
  }

  const defaultCapacityByKey = new Map(UNIT_TYPE_SEEDS.map((s) => [s.key, s.defaultCapacity]));

  const allUnitSeeds = [...ROOM_UNIT_SEEDS, ...COTTAGE_UNIT_SEEDS, ...COMMON_AREA_UNIT_SEEDS];
  console.warn(`Seeding ${allUnitSeeds.length} units (13 rooms, 3 cottages, 7 common areas)...`);
  // Create-if-missing only, deliberately not upsert-with-overwrite: spec
  // §10 itself says "everything seeded here will be replaced on day
  // one" by SYSTEM_ADMIN through the unit management UI (rename/re-code/
  // capacity/type/reorder). Once that happens, re-running this seed
  // (e.g. after a future milestone adds more seed data) must not clobber
  // real property data back to the R01/"Room 1" placeholders.
  for (const seed of allUnitSeeds) {
    const existing = await prisma.unit.findFirst({ where: { code: seed.code } });
    if (existing) continue;

    const unitTypeId = unitTypeIdByKey.get(seed.unitTypeKey);
    const capacity = defaultCapacityByKey.get(seed.unitTypeKey);
    if (!unitTypeId || capacity === undefined) throw new Error(`Unit type ${seed.unitTypeKey} was not seeded`);

    await prisma.unit.create({
      data: { code: seed.code, name: seed.name, unitTypeId, type: seed.type, capacity },
    });
  }

  console.warn(`Seeding ${AMENITY_ITEM_SEEDS.length} amenity items...`);
  // Create-if-missing, same reasoning as unit types/units above: once
  // SYSTEM_ADMIN/RESORT_MANAGER edit the real catalogue through the
  // Amenities admin page, a re-run of this seed must not clobber that
  // back to the placeholder condition/qty. `name` is this seed's
  // idempotency key, same as UnitType — AmenityItem has no other natural
  // unique column.
  for (const seed of AMENITY_ITEM_SEEDS) {
    const existing = await prisma.amenityItem.findFirst({ where: { name: seed.name } });
    if (existing) continue;
    await prisma.amenityItem.create({
      data: {
        name: seed.name,
        category: seed.category,
        totalQty: seed.totalQty,
        condition: 'Good',
        requiresDeposit: seed.requiresDeposit,
        depositAmount: seed.depositAmount,
      },
    });
  }

  console.warn('Seeding workOrder.photoRequirements setting...');
  // Spec §7.2.1: "lives in a Setting... so the client can loosen or
  // tighten it later without a deploy." Unlike units/unit-types, this is
  // config that should always match the shared default until a
  // SYSTEM_ADMIN deliberately edits it — upsert-with-overwrite, same
  // idempotency treatment as permissions/roles above, not create-if-
  // missing. If the client has already customized this Setting through
  // an admin UI (not yet built), overwriting it here would be wrong —
  // revisit this once that UI exists.
  await prisma.setting.upsert({
    where: { key: 'workOrder.photoRequirements' },
    create: { key: 'workOrder.photoRequirements', value: DEFAULT_WORK_ORDER_PHOTO_REQUIREMENTS },
    update: { value: DEFAULT_WORK_ORDER_PHOTO_REQUIREMENTS },
  });

  // booking.dayTourWindow/checkInTime/checkOutTime/turnaroundMinutes
  // Settings removed 2026-08-24: they backed the old reservation
  // availability engine (resolving a booking's startAt/endAt, checking
  // for overlaps) which is gone entirely — this app no longer creates
  // reservations, so there's no window to resolve and no turnaround
  // buffer to enforce. Not retroactively deleted from an already-seeded
  // database — if the client's own Supabase project already has these
  // four Setting rows from an earlier seed run, they're harmless
  // leftovers with no code left reading them; nothing here cleans them
  // up automatically.

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
