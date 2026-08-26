// Mirrors the Prisma `UnitKind` enum (apps/api/prisma/schema.prisma) —
// duplicated here rather than imported from @prisma/client for the same
// reason as departments.ts: packages/shared is imported by apps/web too,
// which must never depend on Prisma.
export const UNIT_KIND_KEYS = ['ROOM', 'COTTAGE', 'COMMON_AREA', 'FACILITY'] as const;

export type UnitKindKey = (typeof UNIT_KIND_KEYS)[number];

// Real bug found live-testing, 2026-08-25: the Check-in picker let
// common areas (Beach Front, CR-Female, CR-Male, Function Hall, Pool,
// Restaurant — COMMON_AREA/FACILITY) be selected as a guest's check-in
// destination, alongside real accommodations. Only ROOM/COTTAGE are
// guest-occupiable — "check a guest into the Pool" doesn't mean
// anything. Shared so both the Check-in picker (web) and
// checkInBooking's own server-side guard (api) read the same list
// rather than each hardcoding it and risking drift.
export const BOOKABLE_UNIT_KINDS: readonly UnitKindKey[] = ['ROOM', 'COTTAGE'];

export function isBookableUnitKind(kind: string): boolean {
  return (BOOKABLE_UNIT_KINDS as readonly string[]).includes(kind);
}
