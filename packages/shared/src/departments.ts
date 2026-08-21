// Mirrors the Prisma `Department` enum (apps/api/prisma/schema.prisma).
// Duplicated here — rather than importing from @prisma/client — because
// packages/shared is imported by apps/web too, which must never depend on
// Prisma. Keep the two lists in sync by hand; a schema change to
// Department without a matching update here is a bug.
export const DEPARTMENT_KEYS = [
  'MANAGEMENT',
  'FRONT_OFFICE',
  'HOUSEKEEPING',
  'MAINTENANCE',
  'GROUNDS_SAFETY',
  'RESTAURANT',
] as const;

export type DepartmentKey = (typeof DEPARTMENT_KEYS)[number];
