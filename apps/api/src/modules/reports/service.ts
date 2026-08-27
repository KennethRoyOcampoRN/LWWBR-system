import { TZDate } from '@date-fns/tz';
import {
  UNIT_KIND_GROUP_LABELS,
  unitKindGroup,
  canViewAmenityUtilisationReport,
  type AmenityRequestStatusKey,
  type DepartmentKey,
  type FnbOrderStatusKey,
  type PermissionKey,
  type PermissionScope,
  type RoleKey,
  type UnitStatusKey,
  type WorkOrderStatusKey,
  type WorkOrderTypeKey,
} from '@lwwbr/shared';
import { addDays, eachDayOfInterval, format } from 'date-fns';
import { getStorageAdapter } from '../../adapters/storage/index.js';
import { ApiError } from '../../lib/apiError.js';
import { toCsv } from '../../lib/csv.js';
import { prisma } from '../../lib/prisma.js';
import type { ReportQuery } from './schema.js';

interface ReportActor {
  department: string;
  permissions: Partial<Record<PermissionKey, PermissionScope>>;
  roles: RoleKey[];
}

// Spec §3.2: "Timezone Asia/Manila everywhere... never store naive local
// time." Same pattern as bookings/service.ts's resolveArrivalDate — a
// report's from/to are calendar dates the client typed, resolved to real
// midnight in Asia/Manila rather than however UTC midnight happens to
// land, so "the 25th" means the same thing here as it does on the
// check-in date picker.
const RESORT_TIMEZONE = 'Asia/Manila';

function resolveDate(dateStr: string): Date {
  const [year, month, day] = dateStr.split('-').map(Number) as [number, number, number];
  return new TZDate(year, month - 1, day, 0, 0, RESORT_TIMEZONE);
}

interface ReportResult {
  summary: unknown;
  rows: Record<string, unknown>[];
  csvColumns: { key: string; label: string }[];
}

// Spec §8.4 item 1: "Occupancy & unit status history (by day, by unit)."
// Built from UnitStatusEvent, real data going back through tonight's
// testing. Rows are the literal "by day, by unit" grid spec names — one
// row per (day, unit), each carrying that unit's status as of the end of
// that day, derived by walking its status-event history forward rather
// than trusting only the live Unit.status column (which only ever holds
// the *current* status). `summary` aggregates that same data into a
// daily occupancy rate so the on-screen view doesn't need the frontend
// to recompute it, but the CSV export carries the detail rows — the
// finer-grained, reconstructable data — same reasoning as the
// work-orders report below.
async function buildOccupancyReport(query: ReportQuery, actor: ReportActor): Promise<ReportResult> {
  // No department axis exists on Unit — occupancy is property-wide by
  // nature. A DEPARTMENT-scoped report:view holder (POC_HOUSEKEEPING,
  // POC_MAINTENANCE, RESTAURANT_MANAGER — see rolePermissions.ts) has
  // nothing of their own department to be scoped to here, so this key is
  // refused for them rather than silently returning the whole property
  // (which their permission scope was never meant to grant) or an empty
  // report (which would look like a bug, not a boundary). This is a
  // report-specific interpretation of a scope spec never spells out per-
  // report; documented here since a future report *with* a department
  // axis (e.g. housekeeping productivity, §8.4 item 5) should NOT follow
  // this same refusal.
  if (actor.permissions['report:view'] === 'DEPARTMENT') {
    throw new ApiError(403, 'FORBIDDEN', 'Occupancy is a property-wide report; your report access is department-scoped.');
  }

  const from = resolveDate(query.from);
  const to = resolveDate(query.to);
  if (from > to) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'from must not be after to');
  }
  const toEndExclusive = addDays(to, 1);

  const units = await prisma.unit.findMany({
    where: { deletedAt: null },
    select: { id: true, code: true, name: true, type: true, createdAt: true },
    orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
  });

  const events = await prisma.unitStatusEvent.findMany({
    where: { unitId: { in: units.map((u) => u.id) }, createdAt: { lt: toEndExclusive } },
    orderBy: [{ createdAt: 'asc' }],
    select: { unitId: true, toStatus: true, createdAt: true },
  });
  const eventsByUnit = new Map<string, { toStatus: UnitStatusKey; createdAt: Date }[]>();
  for (const event of events) {
    const list = eventsByUnit.get(event.unitId) ?? [];
    list.push({ toStatus: event.toStatus as UnitStatusKey, createdAt: event.createdAt });
    eventsByUnit.set(event.unitId, list);
  }

  const days = eachDayOfInterval({ start: from, end: to });
  const rows: Record<string, unknown>[] = [];
  const summary: { date: string; occupiedCount: number; totalUnits: number; occupancyRate: number }[] = [];

  for (const day of days) {
    const dateLabel = format(day, 'yyyy-MM-dd');
    const dayEndExclusive = addDays(day, 1);
    let occupiedCount = 0;
    let totalUnits = 0;

    for (const unit of units) {
      if (unit.createdAt >= dayEndExclusive) continue; // didn't exist yet as of this day
      totalUnits += 1;

      // Column default is VACANT_DIRTY and no event is written at
      // creation (see units/service.ts's createUnit) — that default is
      // the accurate status for any day before the unit's first real
      // transition, not a placeholder.
      let status: UnitStatusKey = 'VACANT_DIRTY';
      for (const event of eventsByUnit.get(unit.id) ?? []) {
        if (event.createdAt < dayEndExclusive) {
          status = event.toStatus;
        } else {
          break;
        }
      }
      if (status === 'OCCUPIED') occupiedCount += 1;

      // Client decision, 2026-08-25: the same three-way grouping applied
      // to the Units grid and the unit-creation form — Rooms & Cottages /
      // Common areas / Facilities — carries into any report/list that
      // shows all units together. Computed here (not left for the
      // frontend to derive) so the CSV export, not just the on-screen
      // view, carries the group.
      const group = unitKindGroup(unit.type);
      rows.push({
        date: dateLabel,
        unitId: unit.id,
        unitCode: unit.code,
        unitName: unit.name,
        group: group ? UNIT_KIND_GROUP_LABELS[group] : unit.type,
        status,
      });
    }

    summary.push({ date: dateLabel, occupiedCount, totalUnits, occupancyRate: totalUnits > 0 ? occupiedCount / totalUnits : 0 });
  }

  return {
    summary: { byDay: summary },
    rows,
    csvColumns: [
      { key: 'date', label: 'Date' },
      { key: 'group', label: 'Group' },
      { key: 'unitCode', label: 'Unit code' },
      { key: 'unitName', label: 'Unit name' },
      { key: 'status', label: 'Status' },
    ],
  };
}

interface WorkOrderReportRow {
  id: string;
  referenceNo: string;
  type: WorkOrderTypeKey;
  department: DepartmentKey;
  status: WorkOrderStatusKey;
  unitCode: string | null;
  unitName: string | null;
  createdAt: string;
  dueAt: string | null;
  completedAt: string | null;
  verifiedAt: string | null;
  slaBreached: boolean;
  timeToCloseMinutes: number | null;
}

// Extends spec §7.2's live computed-field definition (`dueAt < now &&
// status not in (DONE, VERIFIED, CANCELLED)`, see workorders/service.ts's
// listSlaBreachedWorkOrders) to cover *closed* tickets too, since a
// report looking back over a date range needs to count a ticket that was
// finished late, not only one that's still open right now. A ticket
// closed (VERIFIED, falling back to DONE if never verified) after its
// dueAt is breached even though it's no longer open; CANCELLED never
// counts as breached regardless of dueAt, since it was never actually
// worked to completion or failure.
function isSlaBreached(wo: {
  status: WorkOrderStatusKey;
  dueAt: Date | null;
  completedAt: Date | null;
  verifiedAt: Date | null;
}): boolean {
  if (!wo.dueAt || wo.status === 'CANCELLED') return false;
  const closedAt = wo.verifiedAt ?? wo.completedAt;
  if (closedAt) return closedAt > wo.dueAt;
  return new Date() > wo.dueAt;
}

// Spec §8.4 item 4: "Work orders: volume, by type, by department,
// average time-to-close, SLA breaches, top recurring units." Scoped by
// createdAt within [from, to] — "volume" and every derived stat below
// describe tickets *opened* in this period, the standard reporting
// convention, not tickets touched in some other way during it.
// "Time-to-close" uses verifiedAt as the close event (spec's own
// transition table treats VERIFIED, not DONE, as the true close —
// "DONE -> VERIFIED requires workorder:verify"); a ticket only DONE, not
// yet verified, has no close time yet and is excluded from the average
// rather than counted as zero or as still-open.
async function buildWorkOrderReport(query: ReportQuery, actor: ReportActor): Promise<ReportResult> {
  const from = resolveDate(query.from);
  const to = resolveDate(query.to);
  if (from > to) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'from must not be after to');
  }
  const toEndExclusive = addDays(to, 1);

  // Same DEPARTMENT-scope reasoning as workorder:read_all's own
  // visibilityWhereClause (workorders/service.ts) — a DEPARTMENT-scoped
  // report:view holder sees only their own department's data,
  // regardless of what `department` query param they pass; an
  // ALL-scoped caller may optionally narrow with that same param.
  const scope = actor.permissions['report:view'];
  const departmentFilter =
    scope === 'DEPARTMENT' ? (actor.department as DepartmentKey) : (query.department ?? undefined);

  const workOrders = await prisma.workOrder.findMany({
    where: {
      deletedAt: null,
      createdAt: { gte: from, lt: toEndExclusive },
      ...(departmentFilter ? { department: departmentFilter } : {}),
    },
    include: { unit: { select: { code: true, name: true } } },
    orderBy: [{ createdAt: 'asc' }],
  });

  const rows: WorkOrderReportRow[] = workOrders.map((wo) => {
    const closedAt = wo.verifiedAt;
    const timeToCloseMinutes = closedAt ? Math.round((closedAt.getTime() - wo.createdAt.getTime()) / 60_000) : null;
    return {
      id: wo.id,
      referenceNo: wo.referenceNo,
      type: wo.type as WorkOrderTypeKey,
      department: wo.department as DepartmentKey,
      status: wo.status as WorkOrderStatusKey,
      unitCode: wo.unit?.code ?? null,
      unitName: wo.unit?.name ?? null,
      createdAt: wo.createdAt.toISOString(),
      dueAt: wo.dueAt?.toISOString() ?? null,
      completedAt: wo.completedAt?.toISOString() ?? null,
      verifiedAt: wo.verifiedAt?.toISOString() ?? null,
      slaBreached: isSlaBreached(wo),
      timeToCloseMinutes,
    };
  });

  const byType = new Map<string, number>();
  const byDepartment = new Map<string, number>();
  const byUnit = new Map<string, { unitCode: string; unitName: string; count: number }>();
  let closedCount = 0;
  let closedMinutesSum = 0;
  let slaBreachedCount = 0;

  for (const row of rows) {
    byType.set(row.type, (byType.get(row.type) ?? 0) + 1);
    byDepartment.set(row.department, (byDepartment.get(row.department) ?? 0) + 1);
    if (row.slaBreached) slaBreachedCount += 1;
    if (row.timeToCloseMinutes !== null) {
      closedCount += 1;
      closedMinutesSum += row.timeToCloseMinutes;
    }
    if (row.unitCode && row.unitName) {
      const key = row.unitCode;
      const existing = byUnit.get(key);
      byUnit.set(key, { unitCode: row.unitCode, unitName: row.unitName, count: (existing?.count ?? 0) + 1 });
    }
  }

  const topRecurringUnits = [...byUnit.values()].sort((a, b) => b.count - a.count).slice(0, 10);

  const summary = {
    totalVolume: rows.length,
    byType: [...byType.entries()].map(([type, count]) => ({ type, count })),
    byDepartment: [...byDepartment.entries()].map(([department, count]) => ({ department, count })),
    avgTimeToCloseMinutes: closedCount > 0 ? Math.round(closedMinutesSum / closedCount) : null,
    slaBreachedCount,
    topRecurringUnits,
  };

  return {
    summary,
    rows: rows as unknown as Record<string, unknown>[],
    csvColumns: [
      { key: 'referenceNo', label: 'Reference' },
      { key: 'type', label: 'Type' },
      { key: 'department', label: 'Department' },
      { key: 'status', label: 'Status' },
      { key: 'unitCode', label: 'Unit' },
      { key: 'createdAt', label: 'Created' },
      { key: 'dueAt', label: 'Due' },
      { key: 'completedAt', label: 'Completed' },
      { key: 'verifiedAt', label: 'Verified' },
      { key: 'slaBreached', label: 'SLA breached' },
      { key: 'timeToCloseMinutes', label: 'Time to close (min)' },
    ],
  };
}

interface HousekeepingReportRow {
  unitId: string;
  unitCode: string;
  unitName: string;
  attendantId: string;
  attendantName: string;
  cleaningStartedAt: string;
  cleanedAt: string;
  cleanTimeMinutes: number;
}

// Spec §8.4 item 5: "Housekeeping productivity: rooms cleaned per
// attendant, average clean time, QC pass rate." QC pass rate is
// deliberately omitted (client decision, 2026-08-26): there is no live
// QC-step data to report on — the `Inspection` model is defined in the
// schema but nothing in the app ever writes to it, consistent with the
// 2026-08-22 decision that folded QC into the single CLEANED->READY
// click by the same attendant who cleaned the room (see
// packages/shared/src/unitStatus.ts's own comment on that redesign).
// Revisit this if/when a real QC signal is actually captured.
//
// "Rooms cleaned" = a completed CLEANING->CLEANED cycle, credited to
// whichever attendant performed that closing transition. "Clean time" is
// that same cycle's duration, paired against the immediately preceding
// VACANT_DIRTY->CLEANING event for the same unit — an event-pairing walk
// per unit, not a fixed window, since a unit can cycle through
// dirty/clean more than once inside the report's date range. A
// CLEANING->CLEANED event with no preceding CLEANING start observed
// (e.g. a FORCED_CORRECTION straight to CLEANED) has no real clean cycle
// to measure and is skipped, not counted as a zero-duration clean.
//
// "Cleaned within the report range" is judged by the CLEANED event's own
// createdAt (when the work finished), not the CLEANING start — same
// "count by the closing event" convention as the work-order report's
// time-to-close reasoning. A cycle that started before `from` but
// finished inside the range still counts, with its true (possibly
// longer) duration; one that started inside the range but hasn't
// finished by `to` is excluded — it isn't a completed clean yet.
//
// Department axis: unlike occupancy (no department axis at all), this
// report's data genuinely is HOUSEKEEPING's own — every row is an
// attendant's cleaning work. A DEPARTMENT-scoped report:view holder
// whose own department is HOUSEKEEPING sees the report normally (it's
// already entirely their department's data, no filter needed); one from
// any other department has nothing of their own here and is refused,
// same reasoning as occupancy's blanket refusal but department-aware
// rather than blanket, since this report (unlike occupancy) does belong
// to exactly one department.
async function buildHousekeepingReport(query: ReportQuery, actor: ReportActor): Promise<ReportResult> {
  if (actor.permissions['report:view'] === 'DEPARTMENT' && actor.department !== 'HOUSEKEEPING') {
    throw new ApiError(
      403,
      'FORBIDDEN',
      'Housekeeping productivity is scoped to the Housekeeping department; your report access is scoped to a different department.',
    );
  }

  const from = resolveDate(query.from);
  const to = resolveDate(query.to);
  if (from > to) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'from must not be after to');
  }
  const toEndExclusive = addDays(to, 1);

  const events = await prisma.unitStatusEvent.findMany({
    where: { toStatus: { in: ['CLEANING', 'CLEANED'] }, createdAt: { lt: toEndExclusive } },
    orderBy: [{ unitId: 'asc' }, { createdAt: 'asc' }],
    select: {
      unitId: true,
      toStatus: true,
      actorId: true,
      createdAt: true,
      unit: { select: { code: true, name: true } },
      actor: { select: { fullName: true } },
    },
  });

  const rows: HousekeepingReportRow[] = [];
  let cleaningStartedAt: Date | null = null;
  let currentUnitId: string | null = null;

  for (const event of events) {
    if (event.unitId !== currentUnitId) {
      currentUnitId = event.unitId;
      cleaningStartedAt = null;
    }
    if (event.toStatus === 'CLEANING') {
      cleaningStartedAt = event.createdAt;
      continue;
    }
    // toStatus === 'CLEANED'
    if (cleaningStartedAt && event.createdAt >= from && event.createdAt < toEndExclusive) {
      rows.push({
        unitId: event.unitId,
        unitCode: event.unit?.code ?? '',
        unitName: event.unit?.name ?? '',
        attendantId: event.actorId,
        attendantName: event.actor.fullName,
        cleaningStartedAt: cleaningStartedAt.toISOString(),
        cleanedAt: event.createdAt.toISOString(),
        cleanTimeMinutes: Math.round((event.createdAt.getTime() - cleaningStartedAt.getTime()) / 60_000),
      });
    }
    cleaningStartedAt = null;
  }

  const byAttendant = new Map<
    string,
    { attendantId: string; attendantName: string; roomsCleaned: number; totalMinutes: number }
  >();
  for (const row of rows) {
    const existing = byAttendant.get(row.attendantId) ?? {
      attendantId: row.attendantId,
      attendantName: row.attendantName,
      roomsCleaned: 0,
      totalMinutes: 0,
    };
    existing.roomsCleaned += 1;
    existing.totalMinutes += row.cleanTimeMinutes;
    byAttendant.set(row.attendantId, existing);
  }
  const byAttendantSummary = [...byAttendant.values()]
    .map((a) => ({
      attendantId: a.attendantId,
      attendantName: a.attendantName,
      roomsCleaned: a.roomsCleaned,
      avgCleanTimeMinutes: Math.round(a.totalMinutes / a.roomsCleaned),
    }))
    .sort((a, b) => b.roomsCleaned - a.roomsCleaned);

  const totalMinutes = rows.reduce((sum, row) => sum + row.cleanTimeMinutes, 0);

  const summary = {
    totalRoomsCleaned: rows.length,
    avgCleanTimeMinutes: rows.length > 0 ? Math.round(totalMinutes / rows.length) : null,
    byAttendant: byAttendantSummary,
  };

  return {
    summary,
    rows: rows as unknown as Record<string, unknown>[],
    csvColumns: [
      { key: 'unitCode', label: 'Unit' },
      { key: 'unitName', label: 'Unit name' },
      { key: 'attendantName', label: 'Attendant' },
      { key: 'cleaningStartedAt', label: 'Cleaning started' },
      { key: 'cleanedAt', label: 'Cleaned' },
      { key: 'cleanTimeMinutes', label: 'Clean time (min)' },
    ],
  };
}

interface MaintenanceLogPhoto {
  id: string;
  url: string;
  caption: string | null;
}

interface MaintenanceLogRow {
  id: string;
  date: string;
  referenceNo: string;
  title: string;
  status: WorkOrderStatusKey;
  unitCode: string | null;
  unitName: string | null;
  createdAt: string;
  issuePhotos: MaintenanceLogPhoto[];
  completionPhotos: MaintenanceLogPhoto[];
  issuePhotoUrls: string;
  completionPhotoUrls: string;
}

// Spec §8.4 item 6: "Maintenance log by day — includes issue and
// completion photo thumbnails per ticket, so the day's log is visual
// evidence rather than a text list. CSV export carries authenticated
// photo URLs; the Phase 2 PDF export embeds the images two-up per
// ticket." Confirmed against the spec text before building (flagged as
// an assumption going in, since "CSV (Phase 1) and PDF (Phase 2)" reads
// CSV-only at first glance) — the on-screen render is a real image-
// thumbnail requirement even in Phase 1; only PDF embedding is deferred.
//
// "Maintenance log" = WorkOrder rows with type MAINTENANCE — same
// "the report's own type/event data defines its scope, not a department
// tag" reasoning as the housekeeping report, since `department` is an
// independently-set field on WorkOrder (see createWorkOrder) and can in
// principle diverge from `type`. "Issue" and "completion" photos are
// exactly the two kinds DEFAULT_WORK_ORDER_PHOTO_REQUIREMENTS mandates
// for MAINTENANCE tickets (onCreate: ISSUE, onDone: COMPLETION, see
// packages/shared/src/workOrder.ts) — PROGRESS photos, if any, aren't
// part of this report's definition of "the day's visual evidence."
//
// "By day" buckets on createdAt (the date the ticket was opened), same
// convention as the general work-orders report's own date-range scoping
// — not completedAt, since an open ticket with no completion date yet
// still belongs in the log for the day it was filed.
//
// Photo URLs: signed for 1 hour (vs. the 300s default used elsewhere in
// this codebase for a single work-order's live detail view) since a
// report — especially its CSV export — is meant to be reviewed after the
// request that generated it, not only in the instant it renders; 300s
// would make a downloaded CSV's photo links dead before most people
// opened it. Same signed URLs serve both the on-screen thumbnails and
// the CSV export's photo-URL columns, generated once per report build.
const MAINTENANCE_LOG_PHOTO_URL_TTL_SECONDS = 3600;

async function buildMaintenanceLogReport(query: ReportQuery, actor: ReportActor): Promise<ReportResult> {
  if (actor.permissions['report:view'] === 'DEPARTMENT' && actor.department !== 'MAINTENANCE') {
    throw new ApiError(
      403,
      'FORBIDDEN',
      'Maintenance log is scoped to the Maintenance department; your report access is scoped to a different department.',
    );
  }

  const from = resolveDate(query.from);
  const to = resolveDate(query.to);
  if (from > to) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'from must not be after to');
  }
  const toEndExclusive = addDays(to, 1);

  const workOrders = await prisma.workOrder.findMany({
    where: { deletedAt: null, type: 'MAINTENANCE', createdAt: { gte: from, lt: toEndExclusive } },
    include: {
      unit: { select: { code: true, name: true } },
      photos: { where: { deletedAt: null, kind: { in: ['ISSUE', 'COMPLETION'] } }, include: { file: true } },
    },
    orderBy: [{ createdAt: 'asc' }],
  });

  const storage = getStorageAdapter();
  const rows: MaintenanceLogRow[] = await Promise.all(
    workOrders.map(async (wo) => {
      const issuePhotos: MaintenanceLogPhoto[] = [];
      const completionPhotos: MaintenanceLogPhoto[] = [];
      for (const photo of wo.photos) {
        const entry = {
          id: photo.id,
          url: await storage.getSignedUrl(photo.file.storageKey, MAINTENANCE_LOG_PHOTO_URL_TTL_SECONDS),
          caption: photo.caption,
        };
        if (photo.kind === 'ISSUE') issuePhotos.push(entry);
        else completionPhotos.push(entry);
      }
      return {
        id: wo.id,
        date: format(wo.createdAt, 'yyyy-MM-dd'),
        referenceNo: wo.referenceNo,
        title: wo.title,
        status: wo.status as WorkOrderStatusKey,
        unitCode: wo.unit?.code ?? null,
        unitName: wo.unit?.name ?? null,
        createdAt: wo.createdAt.toISOString(),
        issuePhotos,
        completionPhotos,
        issuePhotoUrls: issuePhotos.map((p) => p.url).join('; '),
        completionPhotoUrls: completionPhotos.map((p) => p.url).join('; '),
      };
    }),
  );

  const byDayMap = new Map<string, number>();
  for (const row of rows) {
    byDayMap.set(row.date, (byDayMap.get(row.date) ?? 0) + 1);
  }
  const byDay = [...byDayMap.entries()].map(([date, ticketCount]) => ({ date, ticketCount })).sort((a, b) => a.date.localeCompare(b.date));

  const summary = { totalTickets: rows.length, byDay };

  return {
    summary,
    rows: rows as unknown as Record<string, unknown>[],
    csvColumns: [
      { key: 'date', label: 'Date' },
      { key: 'referenceNo', label: 'Reference' },
      { key: 'title', label: 'Title' },
      { key: 'status', label: 'Status' },
      { key: 'unitCode', label: 'Unit' },
      { key: 'createdAt', label: 'Created' },
      { key: 'issuePhotoUrls', label: 'Issue photo URLs' },
      { key: 'completionPhotoUrls', label: 'Completion photo URLs' },
    ],
  };
}

interface FnbOrderReportRow {
  id: string;
  referenceNo: string;
  type: string;
  status: FnbOrderStatusKey;
  unitCode: string | null;
  guestName: string | null;
  createdAt: string;
  readyAt: string | null;
  prepTimeMinutes: number | null;
  subtotal: number;
}

// Spec §8.4 item 7: "F&B orders: volume, revenue, average prep time, top
// items." Client decision, 2026-08-26: "revenue" here means the sum of
// `FnbOrder.subtotal` — order/menu-item list prices already stored on
// the order and its lines, not a record of money actually collected.
// Same monitoring-not-transactions boundary as everywhere else in this
// app: this is "what was ordered and its listed value," never "what was
// paid" — there is no payment-status field on FnbOrder to tie into
// (`settlement` is only the guest's stated intent, PAY_NOW vs.
// CHARGE_TO_ROOM, not a payment record) and this report doesn't invent
// one.
//
// "Volume" counts every order placed in range regardless of outcome
// (including CANCELLED), same "opened in period" convention as the
// work-orders report's own totalVolume. "Revenue" and "top items"
// deliberately exclude CANCELLED orders: a cancelled order's items were
// never actually prepared or served, so counting its listed value would
// overstate what food/drink volume genuinely moved — this is an
// accuracy call about *order fulfillment*, not a payment-verification
// question, so it stays on the safe side of the boundary the client
// drew rather than needing to be asked about.
//
// "Average prep time" reads literally off the two timestamps the kitchen
// workflow itself already names for this: `preparingAt` -> `readyAt`
// (the PREPARING -> READY duration), not the wider RECEIVED -> READY
// window that would also include queue/acknowledgement wait. Only
// orders with both timestamps set are averaged; an order still in
// progress (no readyAt yet) has no prep time to report.
async function buildFnbOrderReport(query: ReportQuery, actor: ReportActor): Promise<ReportResult> {
  if (actor.permissions['report:view'] === 'DEPARTMENT' && actor.department !== 'RESTAURANT') {
    throw new ApiError(
      403,
      'FORBIDDEN',
      'F&B orders is scoped to the Restaurant department; your report access is scoped to a different department.',
    );
  }

  const from = resolveDate(query.from);
  const to = resolveDate(query.to);
  if (from > to) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'from must not be after to');
  }
  const toEndExclusive = addDays(to, 1);

  const orders = await prisma.fnbOrder.findMany({
    where: { deletedAt: null, createdAt: { gte: from, lt: toEndExclusive } },
    include: {
      unit: { select: { code: true } },
      lines: { where: { deletedAt: null }, select: { menuItemName: true, qty: true, unitPrice: true } },
    },
    orderBy: [{ createdAt: 'asc' }],
  });

  const rows: FnbOrderReportRow[] = orders.map((order) => {
    const prepTimeMinutes =
      order.preparingAt && order.readyAt
        ? Math.round((order.readyAt.getTime() - order.preparingAt.getTime()) / 60_000)
        : null;
    return {
      id: order.id,
      referenceNo: order.referenceNo,
      type: order.type,
      status: order.status as FnbOrderStatusKey,
      unitCode: order.unit?.code ?? null,
      guestName: order.guestName,
      createdAt: order.createdAt.toISOString(),
      readyAt: order.readyAt?.toISOString() ?? null,
      prepTimeMinutes,
      subtotal: Number(order.subtotal),
    };
  });

  const fulfilledOrders = orders.filter((order) => order.status !== 'CANCELLED');
  const totalRevenue = fulfilledOrders.reduce((sum, order) => sum + Number(order.subtotal), 0);

  const prepTimes = rows.filter((r) => r.prepTimeMinutes !== null).map((r) => r.prepTimeMinutes as number);
  const avgPrepTimeMinutes =
    prepTimes.length > 0 ? Math.round(prepTimes.reduce((sum, m) => sum + m, 0) / prepTimes.length) : null;

  const itemQtyByName = new Map<string, number>();
  for (const order of fulfilledOrders) {
    for (const line of order.lines) {
      const name = line.menuItemName ?? '(deleted item)';
      itemQtyByName.set(name, (itemQtyByName.get(name) ?? 0) + line.qty);
    }
  }
  const topItems = [...itemQtyByName.entries()]
    .map(([itemName, qty]) => ({ itemName, qty }))
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 10);

  const summary = {
    totalVolume: rows.length,
    totalRevenue,
    avgPrepTimeMinutes,
    topItems,
  };

  return {
    summary,
    rows: rows as unknown as Record<string, unknown>[],
    csvColumns: [
      { key: 'referenceNo', label: 'Reference' },
      { key: 'type', label: 'Type' },
      { key: 'status', label: 'Status' },
      { key: 'unitCode', label: 'Unit' },
      { key: 'guestName', label: 'Guest' },
      { key: 'createdAt', label: 'Created' },
      { key: 'readyAt', label: 'Ready' },
      { key: 'prepTimeMinutes', label: 'Prep time (min)' },
      { key: 'subtotal', label: 'Subtotal' },
    ],
  };
}

interface AmenityUtilisationRow {
  id: string;
  referenceNo: string;
  itemName: string;
  unitCode: string | null;
  qty: number;
  status: AmenityRequestStatusKey;
  requestedAt: string;
  issuedAt: string | null;
  returnedAt: string | null;
  conditionOnReturn: string | null;
}

// Spec §8.4 item 8: "Amenity utilisation and loss/damage." Client
// decision, 2026-08-26: this report's access is gated by oversight role
// (canViewAmenityUtilisationReport, packages/shared/src/amenityRequest.ts),
// not by report:view's ordinary ALL/DEPARTMENT scope — amenities have no
// single owning department the way housekeeping/maintenance/F&B do, and
// scoping by who can operate amenities would admit every front-line role
// that hands out a towel, not just the people responsible for monitoring
// stock. See that function's own comment for the full reasoning. Because
// access is role-gated rather than scope-gated, this report is always
// built property-wide for whoever passes the role check — there's no
// `department` filter to apply.
//
// "Loss/damage" maps directly onto the real `LOST_DAMAGED` status
// already wired into the amenity request lifecycle (reachable from
// OVERDUE, captured with `conditionOnReturn` — see amenities/service.ts)
// — no new field or inference needed.
//
// "Utilisation" is scoped by `createdAt` (request placed in range), same
// convention as every other report in this file. "Qty issued" sums `qty`
// for any request where `issuedAt` is set, regardless of its current
// status (RETURNED, OVERDUE, or LOST_DAMAGED all passed through ISSUED)
// — a REQUESTED/APPROVED/CANCELLED request never had anything physically
// handed out.
async function buildAmenityUtilisationReport(query: ReportQuery, actor: ReportActor): Promise<ReportResult> {
  if (!canViewAmenityUtilisationReport(actor.roles)) {
    throw new ApiError(
      403,
      'FORBIDDEN',
      'Amenity utilisation is restricted to oversight roles (SYSTEM_ADMIN, RESORT_MANAGER, and amenity-managing POCs).',
    );
  }

  const from = resolveDate(query.from);
  const to = resolveDate(query.to);
  if (from > to) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'from must not be after to');
  }
  const toEndExclusive = addDays(to, 1);

  const requests = await prisma.amenityRequest.findMany({
    where: { deletedAt: null, createdAt: { gte: from, lt: toEndExclusive } },
    include: { unit: { select: { code: true } }, amenityItem: { select: { name: true } } },
    orderBy: [{ createdAt: 'asc' }],
  });

  const rows: AmenityUtilisationRow[] = requests.map((request) => ({
    id: request.id,
    referenceNo: request.referenceNo,
    itemName: request.amenityItemName ?? request.amenityItem?.name ?? '(deleted item)',
    unitCode: request.unit?.code ?? null,
    qty: request.qty,
    status: request.status as AmenityRequestStatusKey,
    requestedAt: request.createdAt.toISOString(),
    issuedAt: request.issuedAt?.toISOString() ?? null,
    returnedAt: request.returnedAt?.toISOString() ?? null,
    conditionOnReturn: request.conditionOnReturn,
  }));

  const byItemMap = new Map<
    string,
    { itemName: string; requestCount: number; qtyIssued: number; lostDamagedCount: number }
  >();
  for (const row of rows) {
    const existing = byItemMap.get(row.itemName) ?? {
      itemName: row.itemName,
      requestCount: 0,
      qtyIssued: 0,
      lostDamagedCount: 0,
    };
    existing.requestCount += 1;
    if (row.issuedAt) existing.qtyIssued += row.qty;
    if (row.status === 'LOST_DAMAGED') existing.lostDamagedCount += 1;
    byItemMap.set(row.itemName, existing);
  }
  const byItem = [...byItemMap.values()].sort((a, b) => b.requestCount - a.requestCount);

  const summary = {
    totalRequests: rows.length,
    totalQtyIssued: rows.reduce((sum, row) => (row.issuedAt ? sum + row.qty : sum), 0),
    lostDamagedCount: rows.filter((row) => row.status === 'LOST_DAMAGED').length,
    byItem,
  };

  return {
    summary,
    rows: rows as unknown as Record<string, unknown>[],
    csvColumns: [
      { key: 'referenceNo', label: 'Reference' },
      { key: 'itemName', label: 'Item' },
      { key: 'unitCode', label: 'Unit' },
      { key: 'qty', label: 'Qty' },
      { key: 'status', label: 'Status' },
      { key: 'requestedAt', label: 'Requested' },
      { key: 'issuedAt', label: 'Issued' },
      { key: 'returnedAt', label: 'Returned' },
      { key: 'conditionOnReturn', label: 'Condition on return' },
    ],
  };
}

interface AuditExtractRow {
  id: string;
  createdAt: string;
  actorId: string | null;
  actorName: string;
  action: string;
  entity: string;
  entityId: string;
  ip: string | null;
  userAgent: string | null;
  before: unknown;
  after: unknown;
}

// Spec §8.4 item 9: "User activity / audit extract (SYSTEM_ADMIN,
// RESORT_MANAGER, OWNER only)." Unlike the amenity report, this
// restriction needs no new role-based gate — `audit:read` is already
// granted to exactly those three roles (see rolePermissions.ts) and
// nowhere else, so checking that one existing permission *is* the
// spec's restriction, verbatim. All three also hold report:view at ALL
// scope, so the router's own requirePermission('report:view') never
// blocks a legitimate caller before reaching this check.
//
// Every AuditLog row's `before`/`after` JSON is already redacted of
// credential material at write time (see auditExtension.ts's
// redactSensitiveFields, applied in prisma.ts's audit extension before
// any row is persisted) — safe to surface here in full to a role that
// already holds audit:read.
//
// Scoped by createdAt, same convention as every other report in this
// file. Spec §9 separately lists a raw `GET /audit-logs?entity=&
// actorId=&from=&to=` browsing endpoint with its own entity/actorId
// filters — that's a distinct, not-yet-built API surface (no dedicated
// audit module exists yet), out of scope for this report-builder slice;
// this report is date-range only, matching every other report here.
async function buildAuditExtractReport(query: ReportQuery, actor: ReportActor): Promise<ReportResult> {
  if (!actor.permissions['audit:read']) {
    throw new ApiError(403, 'FORBIDDEN', 'The audit extract is restricted to SYSTEM_ADMIN, RESORT_MANAGER, and OWNER.');
  }

  const from = resolveDate(query.from);
  const to = resolveDate(query.to);
  if (from > to) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'from must not be after to');
  }
  const toEndExclusive = addDays(to, 1);

  const logs = await prisma.auditLog.findMany({
    where: { createdAt: { gte: from, lt: toEndExclusive } },
    include: { actor: { select: { fullName: true } } },
    orderBy: [{ createdAt: 'asc' }],
  });

  const rows: AuditExtractRow[] = logs.map((log) => ({
    id: log.id,
    createdAt: log.createdAt.toISOString(),
    actorId: log.actorId,
    actorName: log.actor?.fullName ?? (log.actorId ? log.actorId : 'System'),
    action: log.action,
    entity: log.entity,
    entityId: log.entityId,
    ip: log.ip,
    userAgent: log.userAgent,
    before: log.before,
    after: log.after,
  }));

  const byActionMap = new Map<string, number>();
  const byEntityMap = new Map<string, number>();
  const byActorMap = new Map<string, { actorId: string | null; actorName: string; count: number }>();
  for (const row of rows) {
    byActionMap.set(row.action, (byActionMap.get(row.action) ?? 0) + 1);
    byEntityMap.set(row.entity, (byEntityMap.get(row.entity) ?? 0) + 1);
    const actorKey = row.actorId ?? 'system';
    const existing = byActorMap.get(actorKey) ?? { actorId: row.actorId, actorName: row.actorName, count: 0 };
    existing.count += 1;
    byActorMap.set(actorKey, existing);
  }

  const summary = {
    totalEvents: rows.length,
    byAction: [...byActionMap.entries()].map(([action, count]) => ({ action, count })).sort((a, b) => b.count - a.count),
    byEntity: [...byEntityMap.entries()].map(([entity, count]) => ({ entity, count })).sort((a, b) => b.count - a.count),
    topActors: [...byActorMap.values()].sort((a, b) => b.count - a.count).slice(0, 10),
  };

  return {
    summary,
    rows: rows.map((row) => ({
      ...row,
      before: row.before !== null ? JSON.stringify(row.before) : null,
      after: row.after !== null ? JSON.stringify(row.after) : null,
    })) as unknown as Record<string, unknown>[],
    csvColumns: [
      { key: 'createdAt', label: 'Timestamp' },
      { key: 'actorName', label: 'Actor' },
      { key: 'action', label: 'Action' },
      { key: 'entity', label: 'Entity' },
      { key: 'entityId', label: 'Entity ID' },
      { key: 'ip', label: 'IP' },
      { key: 'userAgent', label: 'User agent' },
      { key: 'before', label: 'Before' },
      { key: 'after', label: 'After' },
    ],
  };
}

export async function getReport(key: string, query: ReportQuery, actor: ReportActor): Promise<ReportResult> {
  if (key === 'occupancy') return buildOccupancyReport(query, actor);
  if (key === 'work-orders') return buildWorkOrderReport(query, actor);
  if (key === 'housekeeping') return buildHousekeepingReport(query, actor);
  if (key === 'maintenance-log') return buildMaintenanceLogReport(query, actor);
  if (key === 'fnb-orders') return buildFnbOrderReport(query, actor);
  if (key === 'amenity-utilisation') return buildAmenityUtilisationReport(query, actor);
  if (key === 'audit-extract') return buildAuditExtractReport(query, actor);
  throw new ApiError(404, 'NOT_FOUND', `Unknown report key: ${key}`);
}

export async function getReportCsv(key: string, query: ReportQuery, actor: ReportActor): Promise<string> {
  const { rows, csvColumns } = await getReport(key, query, actor);
  return toCsv(csvColumns, rows);
}
