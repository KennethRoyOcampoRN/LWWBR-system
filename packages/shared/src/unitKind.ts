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

export const UNIT_KIND_LABELS: Record<UnitKindKey, string> = {
  ROOM: 'Room',
  COTTAGE: 'Cottage',
  COMMON_AREA: 'Common area',
  FACILITY: 'Facility',
};

// Client decision, 2026-08-25: three-way grouping used everywhere units
// are listed together — the Units grid, the unit-creation form (type
// determines which group a new unit lands in), and any report/list that
// shows all units at once. "Common areas" (not "Facilities") is the
// label for COMMON_AREA, since that's the real enum value every current
// unit (Pool, Beach Front, CR-Male/Female, Function Hall, Restaurant,
// Open Field) actually holds — confirmed against seed.ts, not assumed.
// FACILITY stays a distinct group in code even though it has zero real
// units today, so a future facility (gym, spa, ...) gets its own section
// automatically, with no code change — never folded into COMMON_AREA.
export const UNIT_KIND_GROUP_KEYS = ['ROOMS_COTTAGES', 'COMMON_AREAS', 'FACILITIES'] as const;

export type UnitKindGroupKey = (typeof UNIT_KIND_GROUP_KEYS)[number];

export const UNIT_KIND_GROUP_LABELS: Record<UnitKindGroupKey, string> = {
  ROOMS_COTTAGES: 'Rooms & Cottages',
  COMMON_AREAS: 'Common areas',
  FACILITIES: 'Facilities',
};

export const UNIT_KIND_TO_GROUP: Record<UnitKindKey, UnitKindGroupKey> = {
  ROOM: 'ROOMS_COTTAGES',
  COTTAGE: 'ROOMS_COTTAGES',
  COMMON_AREA: 'COMMON_AREAS',
  FACILITY: 'FACILITIES',
};

export function unitKindGroup(kind: string): UnitKindGroupKey | undefined {
  return (UNIT_KIND_TO_GROUP as Record<string, UnitKindGroupKey>)[kind];
}
