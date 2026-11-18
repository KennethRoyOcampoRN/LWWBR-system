import { TZDate } from '@date-fns/tz';
import {
  BOOKING_STATUSES_EXCLUDED_FROM_AVAILABILITY,
  canOverrideAutomaticTransition,
  getTransition,
  type BookingStatusKey,
  type EffectivePermissions,
  type PermissionKey,
  type PermissionScope,
  type RoleKey,
  type UnitStatusKey,
} from '@lwwbr/shared';
import { format } from 'date-fns';
import { getRealtimeAdapter } from '../../adapters/realtime/index.js';
import { ApiError } from '../../lib/apiError.js';
import { logAudit } from '../../lib/auditLog.js';
import { prisma } from '../../lib/prisma.js';
// Second cross-module import in this codebase (see
// applyAutomaticUnitStatusChange's own comment below for the first,
// bookings -> units). Spec §7.1: "OCCUPIED -> VACANT_DIRTY happens
// automatically on check-out and auto-creates a HOUSEKEEPING work order
// for that unit" — WorkOrder lifecycle (referenceNo generation, the
// realtime workorder.created broadcast, department notification) is
// owned by the work orders module, so this reuses it rather than
// duplicating a second, parallel ticket-creation path here.
// Real gap found live-testing, 2026-08-25: the Command Center's "Open
// F&B tickets" KPI and "Overdue amenities" attention-queue row both
// still said "Coming in M5" — both modules have been built and confirmed
// working since M5 closed. Same cross-module reuse reasoning as
// workorders/service.js below: one real implementation, not a second
// parallel copy of "what counts as open/overdue" in this file.
import { listOverdueAmenityRequests, type OverdueAmenityRequest } from '../amenities/service.js';
import { countOpenFnbOrders } from '../fnb/service.js';
import { listPendingQuotations, type PendingQuotation } from '../quotations/service.js';
import { listPendingRemittances, type PendingRemittance } from '../remittances/service.js';
import { listLowStockItems, type LowStockItem } from '../stock/service.js';
import {
  countUrgentOpenWorkOrders,
  createWorkOrder,
  listSlaBreachedWorkOrders,
  type SlaBreachedWorkOrder,
} from '../workorders/service.js';
import type {
  ChangeUnitStatusInput,
  CreateUnitInput,
  CreateUnitTypeInput,
  ForceUnitStatusInput,
  UpdateUnitInput,
  UpdateUnitTypeInput,
} from './schema.js';

// Spec §9.1: channel `property`, event `unit.status.changed`, payload
// `{ entityId, actorId, at, summary }` plus whatever else a listener
// needs to patch its own state without a refetch — the unit grid uses
// toStatus/fromStatus/version/note to update the tile in place. A
// broadcast failure (Supabase Realtime down, network hiccup) must never
// fail the status change itself — best-effort, logged, non-fatal; every
// open Units page still recovers via its 60s poll / window-focus
// refetch fallback.
async function broadcastUnitStatusChanged(params: {
  unitId: string;
  code: string;
  fromStatus: UnitStatusKey;
  toStatus: UnitStatusKey;
  actorId: string;
  version: number;
  note: string | null;
}): Promise<void> {
  try {
    await getRealtimeAdapter().emit('property', 'unit.status.changed', {
      entityId: params.unitId,
      actorId: params.actorId,
      at: new Date().toISOString(),
      summary: `${params.code} moved to ${params.toStatus}`,
      fromStatus: params.fromStatus,
      toStatus: params.toStatus,
      version: params.version,
      note: params.note,
    });
  } catch (error) {
    console.error('Realtime broadcast for unit.status.changed failed:', error);
  }
}

// Exported for the bookings module — check-in/check-out are the real
// "automatic" trigger the transition table's own comment has been
// waiting for since M2 ("No booking module yet (M4) to call this
// automatically"). First real cross-module import in this codebase,
// deliberately: Unit/UnitStatusEvent lifecycle is owned here, and a
// booking action is exactly the kind of caller that comment describes —
// this avoids duplicating the version-increment / event-write /
// broadcast logic a second time in the bookings module. Bypasses
// getTransition()'s own permission check entirely (unlike
// changeUnitStatus above): the caller has already gated on its own
// booking:checkin/booking:checkout permission, and this was never a
// manual transition to begin with — this function trusts its caller
// rather than re-deriving authorization for a transition the manual
// table doesn't (and shouldn't) grant to anyone.
//
// 'READY' added, spec.md §13 decision 16, 2026-11-05: releasing a unit
// when a pre-arrival (CONFIRMED) booking is cancelled or marked
// NO_SHOW — a room that was never slept in isn't dirty, so it goes
// straight back to READY, not VACANT_DIRTY. The `toStatus ===
// 'VACANT_DIRTY'` guard below already excludes READY from the
// post-checkout HOUSEKEEPING ticket for free — no change needed there.
export async function applyAutomaticUnitStatusChange(
  unitId: string,
  toStatus: 'OCCUPIED' | 'VACANT_DIRTY' | 'READY',
  actor: { id: string; department: string; roles: readonly RoleKey[]; permissions: Partial<Record<PermissionKey, PermissionScope>> },
): Promise<{ id: string; code: string; fromStatus: UnitStatusKey; toStatus: UnitStatusKey; version: number }> {
  const unit = await prisma.unit.findFirst({ where: { id: unitId, deletedAt: null } });
  if (!unit) {
    throw new ApiError(404, 'NOT_FOUND', 'Unit not found');
  }
  const fromStatus = unit.status as UnitStatusKey;

  const result = await prisma.unit.updateMany({
    where: { id: unitId, version: unit.version },
    data: { status: toStatus, version: { increment: 1 } },
  });
  if (result.count === 0) {
    throw new ApiError(409, 'VERSION_CONFLICT', 'This unit was changed by someone else — refresh and try again.');
  }

  await prisma.unitStatusEvent.create({
    data: { unitId, fromStatus, toStatus, actorId: actor.id, source: 'AUTOMATIC' },
  });

  const newVersion = unit.version + 1;
  await broadcastUnitStatusChanged({
    unitId,
    code: unit.code,
    fromStatus,
    toStatus,
    actorId: actor.id,
    version: newVersion,
    note: null,
  });

  // Spec §7.1: "auto-creates a HOUSEKEEPING work order for that unit."
  // Real gap found live-testing, 2026-08-24: the transition itself was
  // wired (M4's original check-in/check-out slice) but never actually
  // created the ticket — a room going Dirty with nothing alerting
  // housekeeping. Scoped specifically to this real trigger (check-out),
  // not to every path that can reach VACANT_DIRTY — the SYSTEM_ADMIN
  // override and forced-correction panels in changeUnitStatus/
  // forceUnitStatus below are stopgap/data-correction tools, not the
  // spec's actual "on check-out" trigger, and creating a ticket there too
  // was never asked for. No photo required (HOUSEKEEPING's onCreate
  // requirement is empty, see DEFAULT_WORK_ORDER_PHOTO_REQUIREMENTS) and
  // NORMAL priority — this is routine post-checkout turnover, not an
  // urgent ticket that should page the whole department.
  if (toStatus === 'VACANT_DIRTY') {
    try {
      await createWorkOrder(
        {
          type: 'HOUSEKEEPING',
          title: `Post-checkout cleaning — ${unit.code}`,
          priority: 'NORMAL',
          department: 'HOUSEKEEPING',
          unitId,
          photos: [],
        },
        actor,
      );
    } catch (error) {
      console.error('Auto-creating the post-checkout HOUSEKEEPING work order failed:', error);
    }
  }

  return { id: unitId, code: unit.code, fromStatus, toStatus, version: newVersion };
}

// Prisma's Decimal doesn't serialize to a plain JSON number on its own
// (res.json() would emit its internal object shape) — every UnitType
// response goes through this so the API surface is always plain numbers.
function unitTypeToJson<T extends { baseRate: unknown; dayTourRate: unknown; extraPersonRate: unknown }>(
  unitType: T,
) {
  return {
    ...unitType,
    baseRate: Number(unitType.baseRate),
    dayTourRate: unitType.dayTourRate === null ? null : Number(unitType.dayTourRate),
    extraPersonRate: unitType.extraPersonRate === null ? null : Number(unitType.extraPersonRate),
  };
}

export async function listUnitTypes() {
  const unitTypes = await prisma.unitType.findMany({ where: { deletedAt: null }, orderBy: { sortOrder: 'asc' } });
  return unitTypes.map(unitTypeToJson);
}

// Caught live, 2026-11-18: UnitType.name has no uniqueness constraint,
// and the client created a duplicate "Family Room" by accident — two
// rows, indistinguishable by name alone everywhere one is listed.
// Validated here, in the service layer, rather than with a DB
// constraint: a unique index would fail to apply against the client's
// own already-duplicated data, and a migration that can't run against
// real data is worse than the duplicate it would have prevented. Once
// that existing duplicate is cleaned up (one of the two renamed or
// deleted), a partial unique index scoped to isActive — Postgres
// supports a conditional unique index directly, e.g. `CREATE UNIQUE
// INDEX ON "UnitType" (name) WHERE "isActive" AND "deletedAt" IS
// NULL` — becomes worth adding as a second line of defense; not added
// now because the data isn't clean yet. Scoped to active types only,
// per the client's own instruction: a deactivated type can keep a name
// an active one also uses without blocking anything, since it's never
// offered for a new room again.
async function assertUnitTypeNameAvailable(name: string, excludeId?: string): Promise<void> {
  const conflict = await prisma.unitType.findFirst({
    where: { name, isActive: true, deletedAt: null, ...(excludeId ? { id: { not: excludeId } } : {}) },
  });
  if (conflict) {
    throw new ApiError(409, 'UNIT_TYPE_NAME_TAKEN', `An active room type named "${name}" already exists.`);
  }
}

export async function createUnitType(input: CreateUnitTypeInput) {
  await assertUnitTypeNameAvailable(input.name);
  const unitType = await prisma.unitType.create({ data: input });
  return unitTypeToJson(unitType);
}

export async function updateUnitType(id: string, input: UpdateUnitTypeInput) {
  const existing = await prisma.unitType.findFirst({ where: { id, deletedAt: null } });
  if (!existing) {
    throw new ApiError(404, 'NOT_FOUND', 'Unit type not found');
  }
  if (input.name !== undefined && input.name !== existing.name) {
    await assertUnitTypeNameAvailable(input.name, id);
  }
  const unitType = await prisma.unitType.update({ where: { id }, data: input });
  return unitTypeToJson(unitType);
}

// Caught live, 2026-11-18: the client created a duplicate "Family
// Room" by accident with no way to remove it — only Deactivate
// existed. Same rule already used for a folio charge or a payment:
// delete freely when nothing depends on it, refuse clearly when
// something does. No reason required — correcting an accidental
// duplicate is not a financial action the way voiding a charge is.
// Deliberately does NOT require existing.isActive === false first
// (unlike deleteUnit's own two-gate check) — the client's own rule was
// just "no Unit points at the type," not "deactivate first," and this
// mirrors that exactly rather than adding a gate not asked for.
export async function deleteUnitType(id: string) {
  const existing = await prisma.unitType.findFirst({ where: { id, deletedAt: null } });
  if (!existing) {
    throw new ApiError(404, 'NOT_FOUND', 'Unit type not found');
  }
  const unitCount = await prisma.unit.count({ where: { unitTypeId: id, deletedAt: null } });
  if (unitCount > 0) {
    throw new ApiError(
      409,
      'UNIT_TYPE_IN_USE',
      `${unitCount} room${unitCount === 1 ? '' : 's'} still use this room type — reassign ${unitCount === 1 ? 'it' : 'them'} before deleting it.`,
      { unitCount },
    );
  }
  // RatePlanRate has no deletedAt of its own (never an audited
  // document, just a pricing join row) — a rate under a type that no
  // longer exists is meaningless, so this is a real delete, not a
  // soft one, same as the model's own shape already implies.
  await prisma.$transaction([
    prisma.ratePlanRate.deleteMany({ where: { unitTypeId: id } }),
    prisma.unitType.update({ where: { id }, data: { deletedAt: new Date() } }),
  ]);
  return { id };
}

export interface UnitSummary {
  id: string;
  code: string;
  name: string;
  unitTypeId: string;
  type: string;
  capacity: number;
  floor: string | null;
  status: UnitStatusKey;
  version: number;
  notes: string | null;
  isActive: boolean;
  sortOrder: number;
}

export interface UnitCurrentBooking {
  bookingId: string;
  referenceNo: string;
  guestName: string;
  // Added 2026-11-05 (spec.md §13 decision 16 correction): decision 16's
  // own text already claimed this card-level mitigation existed — "the
  // unit card distinguishes a CONFIRMED booking from a CHECKED_IN one
  // visually" — but the field it depends on was never actually added.
  // Without it the Stage C unit card has no way to tell a pre-arrival
  // booking (room OCCUPIED, nobody there yet) from an actual guest.
  status: BookingStatusKey;
}

export interface UnitSummaryWithNote extends UnitSummary {
  latestNote: string | null;
  // Cashier-tab plan (spec.md §13.4, Stage B, 2026-11-05): booking id +
  // guest name on every unit card — previously fetched only inside the
  // drawer, per unit, on open. One batched query below rather than N+1.
  // null for a vacant unit, a common area/facility, or (defensively) an
  // Occupied unit with no resolvable active BookingUnit row.
  currentBooking: UnitCurrentBooking | null;
}

export async function listUnits(): Promise<UnitSummaryWithNote[]> {
  const units = await prisma.unit.findMany({
    where: { deletedAt: null },
    orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
  });

  // The grid tile shows a note (from any of the three status-change
  // panels — normal, override, or forced correction) only while it's
  // still attached to the unit's *latest* status event — it disappears
  // the instant a later transition happens without a note, or gets
  // replaced if the new one has a note of its own. No distinct visual
  // treatment per panel; the source (see forceUnitStatus below) is only
  // used to tag the audit log, not to decide what shows here.
  // `distinct: ['unitId']` + `orderBy: createdAt desc` gets exactly one
  // (the latest) event per unit in a single query.
  const latestEvents = await prisma.unitStatusEvent.findMany({
    where: { unitId: { in: units.map((u) => u.id) } },
    orderBy: { createdAt: 'desc' },
    distinct: ['unitId'],
    select: { unitId: true, note: true },
  });
  const latestByUnitId = new Map(latestEvents.map((e) => [e.unitId, e]));

  // Same "Unit.status === 'OCCUPIED' is the real signal, a booking's own
  // bookkeeping status can lag or get stuck" reasoning as
  // findOccupiedUnitsForReferenceNo/listUpcomingBookingsForUnit in
  // bookings/service.ts, reused here rather than re-derived — only
  // CANCELLED/CHECKED_OUT/NO_SHOW are excluded.
  //
  // Correction, caught in review 2026-11-05 (spec.md §13 decision 16):
  // this used to also claim a unit can never have two simultaneously-
  // active BookingUnit rows, so "the" current booking per unit was
  // always well-defined — true before moveBookingUnit existed. After a
  // room move, a unit has one *released* row (whoever moved out) and
  // one *live* row (whoever's there now), both potentially matching a
  // non-excluded booking. Without a releasedAt filter, the Map built
  // below keys by unitId and the last matching row wins arbitrarily —
  // the unit card could show the wrong guest's name and booking ID,
  // exactly the field the client asked to put on every card.
  // releasedAt: null (BookingUnit's own schema comment) is the one
  // date-independent way to tell "the live assignment" apart from one
  // that's been moved away from.
  const occupiedUnitIds = units.filter((u) => u.status === 'OCCUPIED').map((u) => u.id);
  const activeBookingUnits =
    occupiedUnitIds.length === 0
      ? []
      : await prisma.bookingUnit.findMany({
          where: {
            unitId: { in: occupiedUnitIds },
            deletedAt: null,
            releasedAt: null,
            booking: { deletedAt: null, status: { notIn: [...BOOKING_STATUSES_EXCLUDED_FROM_AVAILABILITY] } },
          },
          select: { unitId: true, booking: { select: { id: true, referenceNo: true, guestName: true, status: true } } },
        });
  const currentBookingByUnitId = new Map(
    activeBookingUnits.map((bu) => [
      bu.unitId,
      {
        bookingId: bu.booking.id,
        referenceNo: bu.booking.referenceNo,
        guestName: bu.booking.guestName,
        status: bu.booking.status as BookingStatusKey,
      },
    ]),
  );

  return units.map((u) => ({
    ...u,
    status: u.status as UnitStatusKey,
    latestNote: latestByUnitId.get(u.id)?.note ?? null,
    currentBooking: currentBookingByUnitId.get(u.id) ?? null,
  }));
}

// Spec §8.1/§8.3: Admin Staff and Cashier place F&B orders "incl.
// advance orders," and Restaurant Staff creates orders too (fnb:create,
// per the role matrix) — but Restaurant Staff holds no unit:read at all
// (spec §5.4's "unit read" row: — for REST_STAFF), so GET /units would
// 403 for them. Same reasoning as listAssignableUsers above (a POC
// holding workorder:assign but not user:read needs a narrowly-scoped
// picker, not a widened boundary): this is gated on fnb:create itself in
// the router, not unit:read, and returns only what an order-placement
// picker needs — not the full unit management payload.
export async function listOrderableUnits() {
  const units = await prisma.unit.findMany({
    where: { deletedAt: null, isActive: true },
    select: { id: true, code: true, name: true, status: true },
    orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
  });
  return units;
}

export async function createUnit(input: CreateUnitInput) {
  const unitType = await prisma.unitType.findFirst({ where: { id: input.unitTypeId, deletedAt: null } });
  if (!unitType) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Unknown unitTypeId');
  }
  const existing = await prisma.unit.findFirst({ where: { code: input.code } });
  if (existing) {
    throw new ApiError(409, 'UNIT_CODE_TAKEN', `Unit code "${input.code}" is already in use`);
  }
  return prisma.unit.create({
    data: { ...input, capacity: input.capacity ?? unitType.defaultCapacity },
  });
}

export async function updateUnit(id: string, input: UpdateUnitInput) {
  const existing = await prisma.unit.findFirst({ where: { id, deletedAt: null } });
  if (!existing) {
    throw new ApiError(404, 'NOT_FOUND', 'Unit not found');
  }
  return prisma.unit.update({ where: { id }, data: input });
}

// Spec.md §13 decision 36 (2026-11-19), reversing the 2026-08-25 design
// directly above this comment (kept only in git history now, not left
// here to contradict this). Client's own words: "i cannot delete rooms
// with history. it should be able to delete but still on reporting. the
// code cannot be reused for records purposes." The original hard-delete
// design refused deletion outright whenever any history existed,
// reasoning that a real `unit.delete()` would FK-violate against six
// relations with no `onDelete: SetNull` and no way to snapshot a room
// the way an order line snapshots a deleted MenuItem's name. That
// reasoning was correct about a *hard* delete; it simply isn't the
// delete the client wants. A **soft** delete (`deletedAt`, same shape
// `deleteUnitType` already uses) sidesteps the FK problem entirely —
// nothing is removed, so there is nothing to violate — and satisfies
// all three of the client's requirements at once: the room disappears
// from the grid and from anything filtering `deletedAt: null`; every
// booking/work order/receipt keeps its real foreign key, so reports
// still join correctly; and `Unit.code` is `@unique` with no
// `deletedAt` scoping on that index, so the code stays reserved at the
// database level forever, regardless of history — confirmed, not
// assumed: `createUnit`'s own `UNIT_CODE_TAKEN` check (`prisma.unit.
// findFirst({ where: { code } })`, no `deletedAt: null` filter) already
// matches a deleted row too, so a deleted room's code was never
// reusable even before this change. The history check is gone
// entirely — a soft delete has nothing left to protect it from. The
// "deactivate first" guard stays: deleting a *live* room is still a
// deliberate two-step action, unchanged from the original design.
// **Not restorable, from anywhere** — no restore endpoint exists for
// this or any other soft-deleted model in this codebase (UnitType,
// RatePlan, FolioCharge, Payment, Geofence, Shift, StockItem all share
// this same one-way `deletedAt` shape with no undo), and this follows
// that same convention rather than inventing an exception for Unit. If
// the client needs the room back, the path is creating a new unit —
// the old code can never be reused for it, by design, which is exactly
// what "reserved for records purposes" means.
export async function deleteUnit(id: string) {
  const existing = await prisma.unit.findFirst({ where: { id, deletedAt: null } });
  if (!existing) {
    throw new ApiError(404, 'NOT_FOUND', 'Unit not found');
  }
  if (existing.isActive) {
    throw new ApiError(409, 'UNIT_STILL_ACTIVE', 'Deactivate the unit before deleting it.');
  }

  await prisma.unit.update({ where: { id }, data: { deletedAt: new Date() } });
}

// Spec §8.2 attention queue: "rooms dirty >3h." SLA-breached work orders
// (work orders module, M3) are also real now — see listSlaBreachedWorkOrders
// in the work orders module, combined into getUnitsDashboard below. This
// route stays gated on unit:read rather than workorder:read; that's not a
// leak in practice because workorder:read is the floor every role holds
// (see rolePermissions.ts's own comment on why) — anyone who can see the
// Command Center already effectively holds it too. Overdue amenities is
// the one remaining item that section lists still un-built — it depends
// on a module that doesn't exist yet (M5). Unverified payments >24h was
// removed outright, not deferred: payment tracking is out of scope for
// this app entirely (client decision, 2026-08-24 — handled by the
// external website/POS, not this system). This constant and the query
// below are for the dirty-room item, computed from `UnitStatusEvent`
// timestamps already in the database.
export const DIRTY_ATTENTION_THRESHOLD_MINUTES = 180;

// Spec §3.2: "Never use the viewer's device timezone... 'today'...
// resolve[s] against Asia/Manila regardless of where the browser sits."
// This is server-side, not the device-timezone case that sentence is
// primarily about, but the same principle holds: a Netlify function's
// process timezone is not guaranteed to be PHT, so `new Date();
// setHours(0,0,0,0)` (the old approach here) silently used whatever TZ
// the process happened to be running in. Same TZDate pattern as
// reports/service.ts's resolveDate and jobs/ownerDigest.ts's
// yesterdayBounds — real gap found 2026-08-26 while building the latter,
// which deliberately did not reuse this then-broken pattern.
const RESORT_TIMEZONE = 'Asia/Manila';

function todayStartInManila(now: Date = new Date()): Date {
  const nowInManila = new TZDate(now, RESORT_TIMEZONE);
  const dateLabel = format(nowInManila, 'yyyy-MM-dd');
  const [year, month, day] = dateLabel.split('-').map(Number) as [number, number, number];
  return new TZDate(year, month - 1, day, 0, 0, RESORT_TIMEZONE);
}

export interface DirtyRoom {
  id: string;
  code: string;
  name: string;
  dirtySince: string;
  dirtyMinutes: number;
}

// Spec §8.2 KPI strip: "Occupied / Ready / Dirty / Out-of-order counts,"
// plus (as of 2026-08-24) two more real ones: open urgent work orders
// (work orders module, M3, done) and today's guest turnover. The turnover
// pair replaces spec's original "arrivals/departures today" concept,
// which assumed a date-based internal reservation system this app no
// longer has (see the Check-in/Check-out redesign) — checkinsToday/
// checkoutsToday instead count actual READY->OCCUPIED / OCCUPIED->
// VACANT_DIRTY UnitStatusEvent rows created today, which answers the
// same real question ("how much guest turnover happened today") from
// data that's genuinely available. Open F&B tickets — real as of
// 2026-08-25 (F&B was still M5-in-progress when this comment was first
// written; that's done now, see countOpenFnbOrders). Pending payment
// verifications was removed outright (not a placeholder): payment
// tracking is out of scope for this app entirely (client decision,
// 2026-08-24), not a later milestone.
// Client-directed feature, 2026-08-31: two more attention-queue/KPI
// sources, remittance:*/quotation:* (see remittances/quotations
// modules). Unlike every field above — which only needs unit:read to
// justify seeing, since unit:read is the floor every role holds — these
// two are the first Command Center data that genuinely isn't universally
// visible: a Housekeeping-only role holds unit:read but not
// remittance:read/quotation:read, and has no other route to that data.
// So `pendingRemittances`/`pendingQuotations`/`remittanceRequests`/
// `quotationRequests` are all optional keys, entirely OMITTED from the
// JSON (not 0/[]) when the caller lacks the matching permission — see
// getUnitsDashboard below. A `0` would be indistinguishable on the wire
// from "the real count is zero," which could let a frontend bug render a
// truthful-looking card to someone with no business seeing the number at
// all; omission makes "no data for you" structurally different from
// "the true count is zero."
//
// Client-directed feature, 2026-08-31 (same slice): low-stock items —
// see stock/service.ts's listLowStockItems for the full reasoning. The
// deliberate contrast with the paragraph above: `lowStockItems` (KPI
// count and queue array both) is the client's own explicit instruction
// to NOT restrict visibility — always present, never optional, unlike
// pendingRemittances/pendingQuotations right above it. Keep it that way;
// don't "fix" it to match the omit-when-unauthorized pattern.
export interface UnitsDashboard {
  kpi: {
    occupied: number;
    ready: number;
    dirty: number;
    outOfOrder: number;
    urgentOpenWorkOrders: number;
    checkinsToday: number;
    checkoutsToday: number;
    openFnbOrders: number;
    pendingRemittances?: number;
    pendingQuotations?: number;
    lowStockItems: number;
  };
  dirtyRooms: DirtyRoom[];
  slaBreachedWorkOrders: SlaBreachedWorkOrder[];
  overdueAmenityRequests: OverdueAmenityRequest[];
  remittanceRequests?: PendingRemittance[];
  quotationRequests?: PendingQuotation[];
  lowStockItems: LowStockItem[];
}

export async function getUnitsDashboard(permissions: EffectivePermissions): Promise<UnitsDashboard> {
  const units = await prisma.unit.findMany({
    where: { deletedAt: null },
    select: { id: true, code: true, name: true, status: true, createdAt: true },
  });

  const kpi = {
    occupied: 0,
    ready: 0,
    dirty: 0,
    outOfOrder: 0,
    urgentOpenWorkOrders: 0,
    checkinsToday: 0,
    checkoutsToday: 0,
    openFnbOrders: 0,
    lowStockItems: 0,
  };
  const dirtyUnits: typeof units = [];
  for (const unit of units) {
    switch (unit.status) {
      case 'OCCUPIED':
        kpi.occupied += 1;
        break;
      case 'READY':
        kpi.ready += 1;
        break;
      case 'VACANT_DIRTY':
        kpi.dirty += 1;
        dirtyUnits.push(unit);
        break;
      case 'OUT_OF_ORDER':
        kpi.outOfOrder += 1;
        break;
    }
  }

  // The event that put a unit into its *current* VACANT_DIRTY state tells
  // us when it became dirty. A unit that has never had a status event
  // (e.g. still sitting at its seeded default) falls back to when the
  // unit row itself was created.
  const latestEvents = dirtyUnits.length
    ? await prisma.unitStatusEvent.findMany({
        where: { unitId: { in: dirtyUnits.map((u) => u.id) } },
        orderBy: { createdAt: 'desc' },
        distinct: ['unitId'],
        select: { unitId: true, createdAt: true },
      })
    : [];
  const dirtySinceByUnitId = new Map(latestEvents.map((e) => [e.unitId, e.createdAt]));

  const now = Date.now();
  const dirtyRooms: DirtyRoom[] = dirtyUnits
    .map((unit) => {
      const dirtySince = dirtySinceByUnitId.get(unit.id) ?? unit.createdAt;
      const dirtyMinutes = Math.floor((now - dirtySince.getTime()) / 60_000);
      return { id: unit.id, code: unit.code, name: unit.name, dirtySince: dirtySince.toISOString(), dirtyMinutes };
    })
    .filter((room) => room.dirtyMinutes >= DIRTY_ATTENTION_THRESHOLD_MINUTES)
    .sort((a, b) => b.dirtyMinutes - a.dirtyMinutes);

  const slaBreachedWorkOrders = await listSlaBreachedWorkOrders();
  kpi.urgentOpenWorkOrders = await countUrgentOpenWorkOrders();

  const startOfToday = todayStartInManila();
  const [checkinsToday, checkoutsToday] = await Promise.all([
    prisma.unitStatusEvent.count({
      where: { fromStatus: 'READY', toStatus: 'OCCUPIED', createdAt: { gte: startOfToday } },
    }),
    prisma.unitStatusEvent.count({
      where: { fromStatus: 'OCCUPIED', toStatus: 'VACANT_DIRTY', createdAt: { gte: startOfToday } },
    }),
  ]);
  kpi.checkinsToday = checkinsToday;
  kpi.checkoutsToday = checkoutsToday;
  kpi.openFnbOrders = await countOpenFnbOrders();
  const overdueAmenityRequests = await listOverdueAmenityRequests();

  // Always computed, no permission check — see this interface's own doc
  // comment for why this is the deliberate opposite of
  // pendingRemittances/pendingQuotations just below.
  const lowStockItems = await listLowStockItems();
  kpi.lowStockItems = lowStockItems.length;

  const dashboard: UnitsDashboard = {
    kpi,
    dirtyRooms,
    slaBreachedWorkOrders,
    overdueAmenityRequests,
    lowStockItems,
  };

  // Independent gates, deliberately not bundled behind a single check:
  // Admin Staff holds remittance:read but not quotation:read (see
  // rolePermissions.ts), so each field is computed and attached only
  // when its own permission is actually held.
  if (permissions['remittance:read']) {
    const remittanceRequests = await listPendingRemittances();
    dashboard.kpi.pendingRemittances = remittanceRequests.length;
    dashboard.remittanceRequests = remittanceRequests;
  }
  if (permissions['quotation:read']) {
    const quotationRequests = await listPendingQuotations();
    dashboard.kpi.pendingQuotations = quotationRequests.length;
    dashboard.quotationRequests = quotationRequests;
  }

  return dashboard;
}

export interface UnitActivityEvent {
  id: string;
  unitId: string;
  unitCode: string;
  unitName: string;
  fromStatus: UnitStatusKey;
  toStatus: UnitStatusKey;
  note: string | null;
  actorName: string;
  createdAt: string;
}

// Spec §8.2 live activity feed: "realtime stream of status changes... a
// flat recent-events list is fine for now." This is the initial list a
// freshly-loaded Command Center renders before any live broadcast has
// arrived — reuses the same `UnitStatusEvent` table the unit timeline
// (getUnitTimeline above) already reads, just across every unit instead
// of one. New events after page load arrive via the existing
// `unit.status.changed` realtime broadcast (see broadcastUnitStatusChanged
// above) — this endpoint is only for backfilling the feed on load.
export async function listUnitActivity(limit: number): Promise<UnitActivityEvent[]> {
  const events = await prisma.unitStatusEvent.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: {
      unit: { select: { code: true, name: true } },
      actor: { select: { fullName: true } },
    },
  });

  return events.map((event) => ({
    id: event.id,
    unitId: event.unitId,
    unitCode: event.unit.code,
    unitName: event.unit.name,
    fromStatus: event.fromStatus as UnitStatusKey,
    toStatus: event.toStatus as UnitStatusKey,
    note: event.note,
    actorName: event.actor.fullName,
    createdAt: event.createdAt.toISOString(),
  }));
}

export async function getUnitTimeline(unitId: string) {
  const unit = await prisma.unit.findFirst({ where: { id: unitId, deletedAt: null } });
  if (!unit) {
    throw new ApiError(404, 'NOT_FOUND', 'Unit not found');
  }
  return prisma.unitStatusEvent.findMany({
    where: { unitId },
    orderBy: { createdAt: 'desc' },
    include: { actor: { select: { id: true, fullName: true, employeeCode: true } } },
  });
}

// Spec §7: "Implement each as an explicit transition table... The API
// validates against the table... Never duplicate this logic." This is
// the sole place a Unit's status actually changes outside seed/test data
// — every rule (which transitions exist, which permission each needs,
// optimistic-concurrency via `version`) is enforced here, once.
export async function changeUnitStatus(
  unitId: string,
  input: ChangeUnitStatusInput,
  actor: { id: string; roles: readonly RoleKey[]; permissions: Partial<Record<PermissionKey, PermissionScope>> },
  meta: { ip?: string | null; userAgent?: string | null } = {},
) {
  const unit = await prisma.unit.findFirst({ where: { id: unitId, deletedAt: null } });
  if (!unit) {
    throw new ApiError(404, 'NOT_FOUND', 'Unit not found');
  }

  const fromStatus = unit.status as UnitStatusKey;
  const transition = getTransition(fromStatus, input.toStatus);
  if (!transition) {
    throw new ApiError(422, 'INVALID_TRANSITION', `Cannot move a unit from ${fromStatus} to ${input.toStatus}`);
  }
  if (!actor.permissions[transition.permission]) {
    throw new ApiError(403, 'FORBIDDEN', `Missing permission: ${transition.permission}`);
  }

  // Manual transitions go through normally. The two remaining "automatic"
  // ones (READY->OCCUPIED, OCCUPIED->VACANT_DIRTY — a third,
  // INSPECTED->READY, existed until INSPECTED was retired the same day,
  // 2026-08-22, as an operational correction: the person who cleans a
  // room QC-inspects and marks it ready in one motion, no separate
  // hand-off) have no real trigger yet — the booking module (M4) that's
  // meant to call them doesn't exist — so without an escape hatch a unit
  // can get stuck with no way forward. SYSTEM_ADMIN only (client
  // decision, 2026-08-22, deliberately excluding RESORT_MANAGER: this is
  // a stopgap testing tool, not a normal operational path) may override,
  // and every use is audited distinctly (see below) so it's visible
  // later how often the override actually gets used — that visibility is
  // what tells us when M4 has closed the gap for real.
  const isOverride = transition.trigger === 'automatic';
  if (isOverride && !canOverrideAutomaticTransition(actor.roles)) {
    throw new ApiError(
      422,
      'INVALID_TRANSITION',
      `${fromStatus} -> ${input.toStatus} happens automatically, not via manual status change`,
    );
  }

  const result = await prisma.unit.updateMany({
    where: { id: unitId, version: input.version },
    data: { status: input.toStatus, version: { increment: 1 } },
  });
  if (result.count === 0) {
    throw new ApiError(409, 'VERSION_CONFLICT', 'This unit was changed by someone else — refresh and try again.');
  }

  await prisma.unitStatusEvent.create({
    data: {
      unitId,
      fromStatus,
      toStatus: input.toStatus,
      actorId: actor.id,
      note: input.note,
      source: isOverride ? 'AUTOMATIC_OVERRIDE' : 'MANUAL',
    },
  });

  if (isOverride) {
    // Distinct from the generic UPDATE row the audit extension already
    // wrote for the prisma.unit.updateMany() above — that row alone
    // wouldn't tell a future reader "this was the stopgap override
    // firing," just that status changed. This is the one that does.
    await logAudit({
      actorId: actor.id,
      action: 'UNIT_STATUS_AUTOMATIC_TRANSITION_OVERRIDE',
      entity: 'Unit',
      entityId: unitId,
      after: { fromStatus, toStatus: input.toStatus, note: input.note ?? null },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  }

  const newVersion = input.version + 1;
  await broadcastUnitStatusChanged({
    unitId,
    code: unit.code,
    fromStatus,
    toStatus: input.toStatus,
    actorId: actor.id,
    version: newVersion,
    note: input.note ?? null,
  });

  return { id: unitId, status: input.toStatus, version: newVersion };
}

export interface BulkUnitStatusResult {
  unitId: string;
  code: string | null;
  status: 'OK' | 'FAILED';
  message?: string;
}

// Spec.md §13 decision 34 (2026-11-18): morning housekeeping — thirteen
// rooms VACANT_DIRTY, one person who'd otherwise click through thirteen
// drawers one at a time. Deliberately reuses changeUnitStatus per room
// rather than a parallel batch implementation — every version check,
// transition check, per-transition permission check, and the automatic-
// trigger override gate all keep working exactly as already tested,
// with no new transition logic to get subtly wrong. That override gate
// is also what guarantees this can never put a room into OCCUPIED
// without a real booking: READY->OCCUPIED is trigger: 'automatic', so
// changeUnitStatus itself refuses it for anyone without the SYSTEM_ADMIN
// override — the same restriction the single-room path already has,
// not a separate check bolted on here that could drift from it.
//
// No cross-room transaction, by the client's own explicit instruction:
// one room's failure must never roll back the rest. Each room's current
// version is read fresh, immediately before its own attempt — never
// trusted from the request — so a genuinely concurrent edit 409s for
// just that one room (reported in its own result) rather than racing a
// version the grid loaded a while ago. Each successful call is its own
// real prisma.unit.updateMany, so the audit extension (lib/
// auditExtension.ts) already writes one row per room — nothing extra
// needed for "each change still audits individually."
export async function bulkChangeUnitStatus(
  unitIds: string[],
  toStatus: UnitStatusKey,
  actor: { id: string; roles: readonly RoleKey[]; permissions: Partial<Record<PermissionKey, PermissionScope>> },
  meta: { ip?: string | null; userAgent?: string | null } = {},
): Promise<{ results: BulkUnitStatusResult[]; succeededCount: number; failedCount: number }> {
  // Spec.md §13 decision 35 (2026-11-19): hard guard, independent of
  // the frontend. `changeUnitStatus` itself would let a SYSTEM_ADMIN
  // override READY->OCCUPIED (the automatic-trigger escape hatch
  // documented on `canOverrideAutomaticTransition`) — fine for a single
  // deliberate correction, never fine for a batch, so bulk refuses
  // OCCUPIED outright before the loop even starts rather than relying
  // on the dropdown never offering it. This is the one thing that must
  // never depend on what the client happens to send.
  if (toStatus === 'OCCUPIED') {
    throw new ApiError(
      422,
      'INVALID_TRANSITION',
      'Occupied happens automatically at check-in — it cannot be set as a bulk status change.',
    );
  }
  const results: BulkUnitStatusResult[] = [];
  for (const unitId of unitIds) {
    const unit = await prisma.unit.findFirst({ where: { id: unitId, deletedAt: null } });
    if (!unit) {
      results.push({ unitId, code: null, status: 'FAILED', message: 'Unit not found' });
      continue;
    }
    try {
      await changeUnitStatus(unitId, { toStatus, version: unit.version }, actor, meta);
      results.push({ unitId, code: unit.code, status: 'OK' });
    } catch (err) {
      results.push({
        unitId,
        code: unit.code,
        status: 'FAILED',
        message: err instanceof ApiError ? err.message : "Could not change this unit's status.",
      });
    }
  }
  const succeededCount = results.filter((r) => r.status === 'OK').length;
  return { results, succeededCount, failedCount: results.length - succeededCount };
}

// Forced status correction (client decision, 2026-08-22): deliberately
// distinct from changeUnitStatus above. Staff sometimes forget to update
// the system in real time, and someone with `unit:force_status` needs to
// jump a unit straight to any of the 8 statuses to correct stale data —
// not limited to the §7.1 sequence, so this bypasses getTransition()
// entirely by design. Gated on a dedicated permission key (not a
// hardcoded role check) so it can be granted to other roles later
// through the Roles admin UI with no code change.
export async function forceUnitStatus(
  unitId: string,
  input: ForceUnitStatusInput,
  actor: { id: string; permissions: Partial<Record<PermissionKey, PermissionScope>> },
  meta: { ip?: string | null; userAgent?: string | null } = {},
) {
  if (!actor.permissions['unit:force_status']) {
    throw new ApiError(403, 'FORBIDDEN', 'Missing permission: unit:force_status');
  }

  const unit = await prisma.unit.findFirst({ where: { id: unitId, deletedAt: null } });
  if (!unit) {
    throw new ApiError(404, 'NOT_FOUND', 'Unit not found');
  }
  const fromStatus = unit.status as UnitStatusKey;

  const result = await prisma.unit.updateMany({
    where: { id: unitId, version: input.version },
    data: { status: input.toStatus, version: { increment: 1 } },
  });
  if (result.count === 0) {
    throw new ApiError(409, 'VERSION_CONFLICT', 'This unit was changed by someone else — refresh and try again.');
  }

  await prisma.unitStatusEvent.create({
    data: {
      unitId,
      fromStatus,
      toStatus: input.toStatus,
      actorId: actor.id,
      note: input.note,
      source: 'FORCED_CORRECTION',
    },
  });

  // Distinct from both the generic UPDATE row the audit extension already
  // writes and from UNIT_STATUS_AUTOMATIC_TRANSITION_OVERRIDE above — this
  // is a different kind of action (any-to-any correction, not a specific
  // automatic transition) and needs its own tag to be identifiable later.
  // The grid tile no longer shows any distinct treatment for a forced
  // correction (client decision, 2026-08-22 — notes now display the same
  // way regardless of which panel set them), so `label` here is what
  // keeps a forced correction identifiable as having bypassed the normal
  // §7.1 sequence once this shows up in an AuditLog viewer.
  await logAudit({
    actorId: actor.id,
    action: 'UNIT_STATUS_FORCED_CORRECTION',
    entity: 'Unit',
    entityId: unitId,
    after: {
      fromStatus,
      toStatus: input.toStatus,
      note: input.note ?? null,
      label: 'Forced correction — bypassed the normal status sequence',
    },
    ip: meta.ip,
    userAgent: meta.userAgent,
  });

  const newVersion = input.version + 1;
  await broadcastUnitStatusChanged({
    unitId,
    code: unit.code,
    fromStatus,
    toStatus: input.toStatus,
    actorId: actor.id,
    version: newVersion,
    note: input.note ?? null,
  });

  return { id: unitId, status: input.toStatus, version: newVersion };
}

