import { TZDate } from '@date-fns/tz';
import {
  UNIT_KIND_GROUP_LABELS,
  unitKindGroup,
  type DepartmentKey,
  type PermissionKey,
  type PermissionScope,
  type UnitStatusKey,
  type WorkOrderStatusKey,
  type WorkOrderTypeKey,
} from '@lwwbr/shared';
import { addDays, eachDayOfInterval, format } from 'date-fns';
import { ApiError } from '../../lib/apiError.js';
import { toCsv } from '../../lib/csv.js';
import { prisma } from '../../lib/prisma.js';
import type { ReportQuery } from './schema.js';

interface ReportActor {
  department: string;
  permissions: Partial<Record<PermissionKey, PermissionScope>>;
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

export async function getReport(key: string, query: ReportQuery, actor: ReportActor): Promise<ReportResult> {
  if (key === 'occupancy') return buildOccupancyReport(query, actor);
  if (key === 'work-orders') return buildWorkOrderReport(query, actor);
  throw new ApiError(404, 'NOT_FOUND', `Unknown report key: ${key}`);
}

export async function getReportCsv(key: string, query: ReportQuery, actor: ReportActor): Promise<string> {
  const { rows, csvColumns } = await getReport(key, query, actor);
  return toCsv(csvColumns, rows);
}
