import {
  canOverrideAutomaticTransition,
  getTransition,
  type PermissionKey,
  type PermissionScope,
  type RoleKey,
  type UnitStatusKey,
} from '@lwwbr/shared';
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
import { createWorkOrder, listSlaBreachedWorkOrders, type SlaBreachedWorkOrder } from '../workorders/service.js';
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
export async function applyAutomaticUnitStatusChange(
  unitId: string,
  toStatus: 'OCCUPIED' | 'VACANT_DIRTY',
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

export async function createUnitType(input: CreateUnitTypeInput) {
  const unitType = await prisma.unitType.create({ data: input });
  return unitTypeToJson(unitType);
}

export async function updateUnitType(id: string, input: UpdateUnitTypeInput) {
  const existing = await prisma.unitType.findFirst({ where: { id, deletedAt: null } });
  if (!existing) {
    throw new ApiError(404, 'NOT_FOUND', 'Unit type not found');
  }
  const unitType = await prisma.unitType.update({ where: { id }, data: input });
  return unitTypeToJson(unitType);
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

export interface UnitSummaryWithNote extends UnitSummary {
  latestNote: string | null;
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

  return units.map((u) => ({
    ...u,
    status: u.status as UnitStatusKey,
    latestNote: latestByUnitId.get(u.id)?.note ?? null,
  }));
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

// Spec §8.2 attention queue: "rooms dirty >3h." SLA-breached work orders
// (work orders module, M3) are also real now — see listSlaBreachedWorkOrders
// in the work orders module, combined into getUnitsDashboard below. This
// route stays gated on unit:read rather than workorder:read; that's not a
// leak in practice because workorder:read is the floor every role holds
// (see rolePermissions.ts's own comment on why) — anyone who can see the
// Command Center already effectively holds it too. Overdue amenities and
// unverified payments >24h are the remaining two items that section lists;
// amenities depend on a module that doesn't exist yet (M5), and payment
// tracking is out of scope for this app entirely (client decision,
// 2026-08-24 — handled by the external website/POS, not this system).
// This constant and the query below are for the dirty-room item, computed
// from `UnitStatusEvent` timestamps already in the database.
export const DIRTY_ATTENTION_THRESHOLD_MINUTES = 180;

export interface DirtyRoom {
  id: string;
  code: string;
  name: string;
  dirtySince: string;
  dirtyMinutes: number;
}

// Spec §8.2 KPI strip: "Occupied / Ready / Dirty / Out-of-order counts."
// Arrivals/departures, urgent work orders, pending payment verifications,
// and open F&B tickets are the other four KPIs that section lists, but
// all four depend on modules that don't exist yet (bookings M4, work
// orders M3, payments M4, F&B M5) — the frontend renders those as
// explicit "coming in a later milestone" placeholders rather than faking
// a plausible-looking zero. Only the four status counts below are real.
export interface UnitsDashboard {
  kpi: {
    occupied: number;
    ready: number;
    dirty: number;
    outOfOrder: number;
  };
  dirtyRooms: DirtyRoom[];
  slaBreachedWorkOrders: SlaBreachedWorkOrder[];
}

export async function getUnitsDashboard(): Promise<UnitsDashboard> {
  const units = await prisma.unit.findMany({
    where: { deletedAt: null },
    select: { id: true, code: true, name: true, status: true, createdAt: true },
  });

  const kpi = { occupied: 0, ready: 0, dirty: 0, outOfOrder: 0 };
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

  return { kpi, dirtyRooms, slaBreachedWorkOrders };
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

