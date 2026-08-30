import { DEPARTMENT_KEYS, REPORT_KEYS, REPORT_LABELS, type DepartmentKey, type ReportKey } from '@lwwbr/shared';
import { useState, type FormEvent } from 'react';
import { EmptyState } from '../components/EmptyState.js';
import { SkeletonTableRows } from '../components/Skeleton.js';
import { useAuth } from '../context/AuthContext.js';
import { api, ApiRequestError } from '../lib/api.js';
import { DEPARTMENT_LABELS } from '../lib/workOrderStyle.js';
import { UNIT_STATUS_LABELS } from '../lib/unitStatusStyle.js';

interface OccupancyRow {
  date: string;
  unitId: string;
  unitCode: string;
  unitName: string;
  // Server-derived label — Rooms & Cottages / Common areas / Facilities,
  // same three-way grouping as the Units grid and unit-creation form.
  group: string;
  status: keyof typeof UNIT_STATUS_LABELS;
}

interface OccupancySummary {
  byDay: { date: string; occupiedCount: number; totalUnits: number; occupancyRate: number }[];
}

interface WorkOrderRow {
  id: string;
  referenceNo: string;
  type: string;
  department: string;
  status: string;
  unitCode: string | null;
  unitName: string | null;
  createdAt: string;
  dueAt: string | null;
  completedAt: string | null;
  verifiedAt: string | null;
  slaBreached: boolean;
  timeToCloseMinutes: number | null;
}

interface WorkOrderSummary {
  totalVolume: number;
  byType: { type: string; count: number }[];
  byDepartment: { department: string; count: number }[];
  avgTimeToCloseMinutes: number | null;
  slaBreachedCount: number;
  topRecurringUnits: { unitCode: string; unitName: string; count: number }[];
}

interface HousekeepingRow {
  unitId: string;
  unitCode: string;
  unitName: string;
  attendantId: string;
  attendantName: string;
  cleaningStartedAt: string;
  cleanedAt: string;
  cleanTimeMinutes: number;
}

interface HousekeepingSummary {
  totalRoomsCleaned: number;
  avgCleanTimeMinutes: number | null;
  byAttendant: { attendantId: string; attendantName: string; roomsCleaned: number; avgCleanTimeMinutes: number }[];
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
  status: string;
  unitCode: string | null;
  unitName: string | null;
  createdAt: string;
  issuePhotos: MaintenanceLogPhoto[];
  completionPhotos: MaintenanceLogPhoto[];
}

interface MaintenanceLogSummary {
  totalTickets: number;
  byDay: { date: string; ticketCount: number }[];
}

interface FnbOrderRow {
  id: string;
  referenceNo: string;
  type: string;
  status: string;
  unitCode: string | null;
  guestName: string | null;
  createdAt: string;
  readyAt: string | null;
  prepTimeMinutes: number | null;
  subtotal: number;
}

interface FnbOrderSummary {
  totalVolume: number;
  totalRevenue: number;
  avgPrepTimeMinutes: number | null;
  topItems: { itemName: string; qty: number }[];
}

interface AmenityUtilisationRow {
  id: string;
  referenceNo: string;
  itemName: string;
  unitCode: string | null;
  qty: number;
  status: string;
  requestedAt: string;
  issuedAt: string | null;
  returnedAt: string | null;
  conditionOnReturn: string | null;
}

interface AmenityUtilisationSummary {
  totalRequests: number;
  totalQtyIssued: number;
  lostDamagedCount: number;
  byItem: { itemName: string; requestCount: number; qtyIssued: number; lostDamagedCount: number }[];
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
  before: string | null;
  after: string | null;
}

interface AuditExtractSummary {
  totalEvents: number;
  byAction: { action: string; count: number }[];
  byEntity: { entity: string; count: number }[];
  topActors: { actorId: string | null; actorName: string; count: number }[];
}

type ReportResponse =
  | { key: 'occupancy'; from: string; to: string; summary: OccupancySummary; rows: OccupancyRow[] }
  | { key: 'work-orders'; from: string; to: string; summary: WorkOrderSummary; rows: WorkOrderRow[] }
  | { key: 'housekeeping'; from: string; to: string; summary: HousekeepingSummary; rows: HousekeepingRow[] }
  | { key: 'maintenance-log'; from: string; to: string; summary: MaintenanceLogSummary; rows: MaintenanceLogRow[] }
  | { key: 'fnb-orders'; from: string; to: string; summary: FnbOrderSummary; rows: FnbOrderRow[] }
  | {
      key: 'amenity-utilisation';
      from: string;
      to: string;
      summary: AmenityUtilisationSummary;
      rows: AmenityUtilisationRow[];
    }
  | { key: 'audit-extract'; from: string; to: string; summary: AuditExtractSummary; rows: AuditExtractRow[] };

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatPercent(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

function formatMinutes(minutes: number | null): string {
  if (minutes === null) return '—';
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

// Order/menu-item list value, not a payment figure — same "₱" formatting
// FnbPage.tsx already uses for menu prices; no payment-collected concept
// exists on FnbOrder to format instead.
function formatPeso(amount: number): string {
  return `₱${amount.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Spec §8.4 report builder — M6's first slice (2026-08-25): the two
// reports with the most real data already behind them from tonight's
// testing (UnitStatusEvent, real work orders). Every report renders on
// screen and exports to CSV, per spec; no revenue/payment figures are
// touched by either of these two, so the monitoring-not-transactions
// scope call doesn't come up here (it will for F&B/payments reports
// later).
export function ReportsPage() {
  const { user } = useAuth();
  const canExport = Boolean(user?.permissions['report:export']);

  const [reportKey, setReportKey] = useState<ReportKey>('occupancy');
  const [from, setFrom] = useState(todayIso());
  const [to, setTo] = useState(todayIso());
  const [department, setDepartment] = useState<DepartmentKey | ''>('');
  const [report, setReport] = useState<ReportResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const buildQuery = () => {
    const params = new URLSearchParams({ from, to });
    if (reportKey === 'work-orders' && department) params.set('department', department);
    return params.toString();
  };

  const runReport = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setLoadError(null);
    setExportError(null);
    try {
      const res = await api.get<{ report: ReportResponse }>(`/reports/${reportKey}?${buildQuery()}`);
      setReport(res.report);
    } catch (err) {
      setReport(null);
      setLoadError(err instanceof ApiRequestError ? err.message : 'Could not load the report.');
    } finally {
      setLoading(false);
    }
  };

  const exportCsv = async () => {
    setExporting(true);
    setExportError(null);
    try {
      const blob = await api.downloadCsv(`/reports/${reportKey}/export?${buildQuery()}&format=csv`);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${reportKey}-${from}-to-${to}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setExportError(err instanceof ApiRequestError ? err.message : 'Could not export the report.');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-lg font-semibold">Reports</h1>
        <p className="text-sm text-gray-500">Date-ranged reports, rendered on screen and exportable to CSV.</p>
      </div>

      <form onSubmit={(e) => void runReport(e)} className="flex flex-wrap items-end gap-3 rounded border border-gray-200 p-4">
        <label className="flex flex-col gap-1 text-xs font-medium text-gray-600">
          Report
          <select
            value={reportKey}
            onChange={(e) => {
              setReportKey(e.target.value as ReportKey);
              setReport(null);
            }}
            className="rounded border border-gray-300 px-2 py-1 text-sm"
          >
            {REPORT_KEYS.map((key) => (
              <option key={key} value={key}>
                {REPORT_LABELS[key]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-gray-600">
          From
          <input
            required
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="rounded border border-gray-300 px-2 py-1 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-gray-600">
          To
          <input
            required
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="rounded border border-gray-300 px-2 py-1 text-sm"
          />
        </label>
        {/* Occupancy has no department axis (see the API's own 403 for a
            DEPARTMENT-scoped report:view holder on that key) — this
            filter only makes sense for work-orders. */}
        {reportKey === 'work-orders' && (
          <label className="flex flex-col gap-1 text-xs font-medium text-gray-600">
            Department (optional)
            <select
              value={department}
              onChange={(e) => setDepartment(e.target.value as DepartmentKey | '')}
              className="rounded border border-gray-300 px-2 py-1 text-sm"
            >
              <option value="">All</option>
              {DEPARTMENT_KEYS.map((key) => (
                <option key={key} value={key}>
                  {DEPARTMENT_LABELS[key]}
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          type="submit"
          disabled={loading}
          className="rounded bg-blue-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {loading ? 'Running…' : 'Run report'}
        </button>
        {canExport && (
          <button
            type="button"
            onClick={() => void exportCsv()}
            disabled={exporting}
            className="rounded border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 disabled:opacity-50"
          >
            {exporting ? 'Exporting…' : 'Export CSV'}
          </button>
        )}
      </form>

      {loadError && <p role="alert" className="text-sm text-red-700">{loadError}</p>}
      {exportError && <p role="alert" className="text-sm text-red-700">{exportError}</p>}

      {/* Real gap found in the loading/empty-state audit, 2026-08-26: this
          results pane previously had no loading indicator at all — only
          the "Run report" button's own label changed to "Running…". */}
      {loading && (
        <table className="min-w-full text-sm">
          <tbody>
            <SkeletonTableRows rows={5} columns={5} />
          </tbody>
        </table>
      )}

      {report?.key === 'occupancy' && <OccupancyReportView report={report} />}
      {report?.key === 'work-orders' && <WorkOrderReportView report={report} />}
      {report?.key === 'housekeeping' && <HousekeepingReportView report={report} />}
      {report?.key === 'maintenance-log' && <MaintenanceLogReportView report={report} />}
      {report?.key === 'fnb-orders' && <FnbOrderReportView report={report} />}
      {report?.key === 'amenity-utilisation' && <AmenityUtilisationReportView report={report} />}
      {report?.key === 'audit-extract' && <AuditExtractReportView report={report} />}
    </div>
  );
}

function OccupancyReportView({ report }: { report: Extract<ReportResponse, { key: 'occupancy' }> }) {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="mb-2 text-sm font-semibold text-gray-700">Daily occupancy</h2>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead>
              <tr className="text-left text-xs font-medium uppercase text-gray-500">
                <th className="py-2 pr-4">Date</th>
                <th className="py-2 pr-4">Occupied</th>
                <th className="py-2 pr-4">Total units</th>
                <th className="py-2 pr-4">Occupancy rate</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {report.summary.byDay.map((day) => (
                <tr key={day.date}>
                  <td className="py-2 pr-4 font-medium">{day.date}</td>
                  <td className="py-2 pr-4">{day.occupiedCount}</td>
                  <td className="py-2 pr-4">{day.totalUnits}</td>
                  <td className="py-2 pr-4">{formatPercent(day.occupancyRate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-gray-700">Unit status history — by day, by unit</h2>
        <div className="max-h-96 overflow-auto rounded border border-gray-200">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="sticky top-0 bg-white">
              <tr className="text-left text-xs font-medium uppercase text-gray-500">
                <th className="py-2 pr-4 pl-2">Date</th>
                <th className="py-2 pr-4">Group</th>
                <th className="py-2 pr-4">Unit</th>
                <th className="py-2 pr-4">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {report.rows.map((row) => (
                <tr key={`${row.date}-${row.unitId}`}>
                  <td className="py-2 pr-4 pl-2">{row.date}</td>
                  <td className="py-2 pr-4 text-xs text-gray-500">{row.group}</td>
                  <td className="py-2 pr-4">
                    {row.unitCode} — {row.unitName}
                  </td>
                  <td className="py-2 pr-4">{UNIT_STATUS_LABELS[row.status] ?? row.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function WorkOrderReportView({ report }: { report: Extract<ReportResponse, { key: 'work-orders' }> }) {
  const { summary, rows } = report;
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded border border-gray-200 p-3">
          <p className="text-xs font-medium uppercase text-gray-500">Volume</p>
          <p className="text-2xl font-semibold">{summary.totalVolume}</p>
        </div>
        <div className="rounded border border-gray-200 p-3">
          <p className="text-xs font-medium uppercase text-gray-500">Avg. time to close</p>
          <p className="text-2xl font-semibold">{formatMinutes(summary.avgTimeToCloseMinutes)}</p>
        </div>
        <div className="rounded border border-gray-200 p-3">
          <p className="text-xs font-medium uppercase text-gray-500">SLA breaches</p>
          <p className="text-2xl font-semibold">{summary.slaBreachedCount}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
        <div>
          <h2 className="mb-2 text-sm font-semibold text-gray-700">By type</h2>
          <ul className="flex flex-col gap-1 text-sm">
            {summary.byType.map((row) => (
              <li key={row.type} className="flex justify-between border-b border-gray-100 py-1">
                <span>{row.type}</span>
                <span className="font-medium">{row.count}</span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h2 className="mb-2 text-sm font-semibold text-gray-700">By department</h2>
          <ul className="flex flex-col gap-1 text-sm">
            {summary.byDepartment.map((row) => (
              <li key={row.department} className="flex justify-between border-b border-gray-100 py-1">
                <span>{DEPARTMENT_LABELS[row.department as DepartmentKey] ?? row.department}</span>
                <span className="font-medium">{row.count}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-gray-700">Top recurring units</h2>
        {summary.topRecurringUnits.length === 0 && <EmptyState message="No unit-linked tickets in range." />}
        {summary.topRecurringUnits.length > 0 && (
          <ul className="flex flex-col gap-1 text-sm">
            {summary.topRecurringUnits.map((row) => (
              <li key={row.unitCode} className="flex justify-between border-b border-gray-100 py-1">
                <span>
                  {row.unitCode} — {row.unitName}
                </span>
                <span className="font-medium">{row.count}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-gray-700">Tickets in range</h2>
        <div className="max-h-96 overflow-auto rounded border border-gray-200">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="sticky top-0 bg-white">
              <tr className="text-left text-xs font-medium uppercase text-gray-500">
                <th className="py-2 pr-4 pl-2">Reference</th>
                <th className="py-2 pr-4">Type</th>
                <th className="py-2 pr-4">Department</th>
                <th className="py-2 pr-4">Status</th>
                <th className="py-2 pr-4">Unit</th>
                <th className="py-2 pr-4">Created</th>
                <th className="py-2 pr-4">SLA</th>
                <th className="py-2 pr-4">Time to close</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="py-2 pr-4 pl-2 font-medium">{row.referenceNo}</td>
                  <td className="py-2 pr-4">{row.type}</td>
                  <td className="py-2 pr-4">{DEPARTMENT_LABELS[row.department as DepartmentKey] ?? row.department}</td>
                  <td className="py-2 pr-4">{row.status}</td>
                  <td className="py-2 pr-4">{row.unitCode ?? '—'}</td>
                  <td className="py-2 pr-4">{new Date(row.createdAt).toLocaleString()}</td>
                  <td className="py-2 pr-4">{row.slaBreached ? 'Breached' : '—'}</td>
                  <td className="py-2 pr-4">{formatMinutes(row.timeToCloseMinutes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// Spec §8.4 item 5's three stats are "rooms cleaned per attendant,
// average clean time, QC pass rate" — QC pass rate is omitted here, per
// the same client decision documented in the API's buildHousekeepingReport
// (reports/service.ts): no QC step actually produces data to report on
// today, since cleaning and marking a room ready happen in one motion by
// the same attendant.
function HousekeepingReportView({ report }: { report: Extract<ReportResponse, { key: 'housekeeping' }> }) {
  const { summary, rows } = report;
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded border border-gray-200 p-3">
          <p className="text-xs font-medium uppercase text-gray-500">Rooms cleaned</p>
          <p className="text-2xl font-semibold">{summary.totalRoomsCleaned}</p>
        </div>
        <div className="rounded border border-gray-200 p-3">
          <p className="text-xs font-medium uppercase text-gray-500">Avg. clean time</p>
          <p className="text-2xl font-semibold">{formatMinutes(summary.avgCleanTimeMinutes)}</p>
        </div>
      </div>
      <p className="text-xs text-gray-500">
        QC pass rate isn't shown — housekeeping has no separate QC step to report on; the attendant who cleans a
        room marks it ready in the same motion.
      </p>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-gray-700">By attendant</h2>
        {summary.byAttendant.length === 0 && <EmptyState message="No completed cleans in range." />}
        {summary.byAttendant.length > 0 && (
          <ul className="flex flex-col gap-1 text-sm">
            {summary.byAttendant.map((row) => (
              <li key={row.attendantId} className="flex justify-between border-b border-gray-100 py-1">
                <span>{row.attendantName}</span>
                <span className="font-medium">
                  {row.roomsCleaned} rooms · avg {formatMinutes(row.avgCleanTimeMinutes)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-gray-700">Cleans in range</h2>
        <div className="max-h-96 overflow-auto rounded border border-gray-200">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="sticky top-0 bg-white">
              <tr className="text-left text-xs font-medium uppercase text-gray-500">
                <th className="py-2 pr-4 pl-2">Unit</th>
                <th className="py-2 pr-4">Attendant</th>
                <th className="py-2 pr-4">Cleaning started</th>
                <th className="py-2 pr-4">Cleaned</th>
                <th className="py-2 pr-4">Clean time</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((row) => (
                <tr key={`${row.unitId}-${row.cleanedAt}`}>
                  <td className="py-2 pr-4 pl-2 font-medium">
                    {row.unitCode} — {row.unitName}
                  </td>
                  <td className="py-2 pr-4">{row.attendantName}</td>
                  <td className="py-2 pr-4">{new Date(row.cleaningStartedAt).toLocaleString()}</td>
                  <td className="py-2 pr-4">{new Date(row.cleanedAt).toLocaleString()}</td>
                  <td className="py-2 pr-4">{formatMinutes(row.cleanTimeMinutes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function PhotoThumbnails({ photos, emptyLabel }: { photos: MaintenanceLogPhoto[]; emptyLabel: string }) {
  if (photos.length === 0) return <span className="text-xs text-gray-400">{emptyLabel}</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {photos.map((photo) => (
        <a key={photo.id} href={photo.url} target="_blank" rel="noreferrer" title={photo.caption ?? undefined}>
          <img src={photo.url} alt={photo.caption ?? 'Ticket photo'} className="h-12 w-12 rounded object-cover" />
        </a>
      ))}
    </div>
  );
}

// Spec §8.4 item 6: "includes issue and completion photo thumbnails per
// ticket, so the day's log is visual evidence rather than a text list."
// Real thumbnails (<img>), not just links — confirmed against the spec
// text before building, since "CSV (Phase 1) and PDF (Phase 2)" export
// formats read CSV-only at a glance; the on-screen thumbnail requirement
// applies in Phase 1 regardless, only PDF embedding waits for Phase 2.
// Photo URLs are signed for 1 hour server-side (see the API's
// buildMaintenanceLogReport) rather than the shorter TTL used for a
// single work order's live detail view, since this same report response
// also backs the CSV export — a link that's meant to still work after
// the file is downloaded and opened later.
function MaintenanceLogReportView({ report }: { report: Extract<ReportResponse, { key: 'maintenance-log' }> }) {
  const { summary, rows } = report;
  return (
    <div className="flex flex-col gap-6">
      <div className="rounded border border-gray-200 p-3 sm:w-64">
        <p className="text-xs font-medium uppercase text-gray-500">Tickets</p>
        <p className="text-2xl font-semibold">{summary.totalTickets}</p>
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-gray-700">By day</h2>
        {summary.byDay.length === 0 && <EmptyState message="No maintenance tickets in range." />}
        {summary.byDay.length > 0 && (
          <ul className="flex flex-col gap-1 text-sm">
            {summary.byDay.map((day) => (
              <li key={day.date} className="flex justify-between border-b border-gray-100 py-1">
                <span>{day.date}</span>
                <span className="font-medium">{day.ticketCount} ticket(s)</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-gray-700">Maintenance log</h2>
        <div className="flex flex-col gap-3">
          {rows.map((row) => (
            <div key={row.id} className="rounded border border-gray-200 p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm font-medium">
                  {row.date} — {row.referenceNo}: {row.title}
                </p>
                <p className="text-xs text-gray-500">
                  {row.unitCode ? `${row.unitCode} — ${row.unitName} · ` : ''}
                  {row.status}
                </p>
              </div>
              <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <p className="mb-1 text-xs font-medium uppercase text-gray-500">Issue</p>
                  <PhotoThumbnails photos={row.issuePhotos} emptyLabel="No issue photo" />
                </div>
                <div>
                  <p className="mb-1 text-xs font-medium uppercase text-gray-500">Completion</p>
                  <PhotoThumbnails photos={row.completionPhotos} emptyLabel="No completion photo yet" />
                </div>
              </div>
            </div>
          ))}
          {rows.length === 0 && <EmptyState message="No maintenance tickets in range." />}
        </div>
      </div>
    </div>
  );
}

// Spec §8.4 item 7: "F&B orders: volume, revenue, average prep time, top
// items." "Revenue" here is the sum of each order's listed subtotal —
// what was ordered and its listed value — not a record of money actually
// collected; there is no payment-status field on FnbOrder to report on
// instead (client decision, 2026-08-26, same monitoring-not-transactions
// boundary as the rest of this app). Cancelled orders are excluded from
// revenue and top items (their food/drink was never actually prepared or
// served) but still counted in volume, same "opened in period"
// convention as the work-orders report.
function FnbOrderReportView({ report }: { report: Extract<ReportResponse, { key: 'fnb-orders' }> }) {
  const { summary, rows } = report;
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded border border-gray-200 p-3">
          <p className="text-xs font-medium uppercase text-gray-500">Volume</p>
          <p className="text-2xl font-semibold">{summary.totalVolume}</p>
        </div>
        <div className="rounded border border-gray-200 p-3">
          <p className="text-xs font-medium uppercase text-gray-500">Revenue (listed value)</p>
          <p className="text-2xl font-semibold">{formatPeso(summary.totalRevenue)}</p>
        </div>
        <div className="rounded border border-gray-200 p-3">
          <p className="text-xs font-medium uppercase text-gray-500">Avg. prep time</p>
          <p className="text-2xl font-semibold">{formatMinutes(summary.avgPrepTimeMinutes)}</p>
        </div>
      </div>
      <p className="text-xs text-gray-500">
        "Revenue" is the total listed value of what was ordered (cancelled orders excluded) — it does not mean
        payment was collected or verified; this app doesn't track that.
      </p>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-gray-700">Top items</h2>
        {summary.topItems.length === 0 && <EmptyState message="No fulfilled orders in range." />}
        {summary.topItems.length > 0 && (
          <ul className="flex flex-col gap-1 text-sm">
            {summary.topItems.map((item) => (
              <li key={item.itemName} className="flex justify-between border-b border-gray-100 py-1">
                <span>{item.itemName}</span>
                <span className="font-medium">{item.qty}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-gray-700">Orders in range</h2>
        <div className="max-h-96 overflow-auto rounded border border-gray-200">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="sticky top-0 bg-white">
              <tr className="text-left text-xs font-medium uppercase text-gray-500">
                <th className="py-2 pr-4 pl-2">Reference</th>
                <th className="py-2 pr-4">Type</th>
                <th className="py-2 pr-4">Status</th>
                <th className="py-2 pr-4">Unit</th>
                <th className="py-2 pr-4">Created</th>
                <th className="py-2 pr-4">Prep time</th>
                <th className="py-2 pr-4">Subtotal</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="py-2 pr-4 pl-2 font-medium">{row.referenceNo}</td>
                  <td className="py-2 pr-4">{row.type}</td>
                  <td className="py-2 pr-4">{row.status}</td>
                  <td className="py-2 pr-4">{row.unitCode ?? '—'}</td>
                  <td className="py-2 pr-4">{new Date(row.createdAt).toLocaleString()}</td>
                  <td className="py-2 pr-4">{formatMinutes(row.prepTimeMinutes)}</td>
                  <td className="py-2 pr-4">{formatPeso(row.subtotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// Spec §8.4 item 8: "Amenity utilisation and loss/damage." Access to
// this report is restricted server-side to oversight roles (SYSTEM_ADMIN,
// RESORT_MANAGER, and amenity-managing POCs) rather than the ordinary
// report:view ALL/DEPARTMENT split — see the API's canViewAmenityUtilisationReport
// for the full reasoning (amenities have no single owning department the
// way housekeeping/maintenance/F&B do). A caller without that role gets
// a 403 from the API like any other permission refusal; nothing extra to
// render here for that case. "Loss/damage" is the real LOST_DAMAGED
// status already wired into the amenity request lifecycle, not a new
// concept.
function AmenityUtilisationReportView({ report }: { report: Extract<ReportResponse, { key: 'amenity-utilisation' }> }) {
  const { summary, rows } = report;
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded border border-gray-200 p-3">
          <p className="text-xs font-medium uppercase text-gray-500">Requests</p>
          <p className="text-2xl font-semibold">{summary.totalRequests}</p>
        </div>
        <div className="rounded border border-gray-200 p-3">
          <p className="text-xs font-medium uppercase text-gray-500">Qty issued</p>
          <p className="text-2xl font-semibold">{summary.totalQtyIssued}</p>
        </div>
        <div className="rounded border border-red-200 bg-red-50 p-3">
          <p className="text-xs font-medium uppercase text-red-700">Lost / damaged</p>
          <p className="text-2xl font-semibold text-red-900">{summary.lostDamagedCount}</p>
        </div>
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-gray-700">By item</h2>
        {summary.byItem.length === 0 && <EmptyState message="No amenity requests in range." />}
        {summary.byItem.length > 0 && (
          <ul className="flex flex-col gap-1 text-sm">
            {summary.byItem.map((item) => (
              <li key={item.itemName} className="flex justify-between border-b border-gray-100 py-1">
                <span>{item.itemName}</span>
                <span className="font-medium">
                  {item.requestCount} requests · {item.qtyIssued} issued
                  {item.lostDamagedCount > 0 ? ` · ${item.lostDamagedCount} lost/damaged` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-gray-700">Requests in range</h2>
        <div className="max-h-96 overflow-auto rounded border border-gray-200">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="sticky top-0 bg-white">
              <tr className="text-left text-xs font-medium uppercase text-gray-500">
                <th className="py-2 pr-4 pl-2">Reference</th>
                <th className="py-2 pr-4">Item</th>
                <th className="py-2 pr-4">Unit</th>
                <th className="py-2 pr-4">Qty</th>
                <th className="py-2 pr-4">Status</th>
                <th className="py-2 pr-4">Requested</th>
                <th className="py-2 pr-4">Condition on return</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((row) => (
                <tr key={row.id} className={row.status === 'LOST_DAMAGED' ? 'bg-red-50' : undefined}>
                  <td className="py-2 pr-4 pl-2 font-medium">{row.referenceNo}</td>
                  <td className="py-2 pr-4">{row.itemName}</td>
                  <td className="py-2 pr-4">{row.unitCode ?? '—'}</td>
                  <td className="py-2 pr-4">{row.qty}</td>
                  <td className="py-2 pr-4">{row.status}</td>
                  <td className="py-2 pr-4">{new Date(row.requestedAt).toLocaleString()}</td>
                  <td className="py-2 pr-4">{row.conditionOnReturn ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// Spec §8.4 item 9: "User activity / audit extract (SYSTEM_ADMIN,
// RESORT_MANAGER, OWNER only)." Access is gated server-side on the
// audit:read permission — already granted to exactly those three roles
// — so a caller without it never reaches this view; nothing extra to
// gate client-side. Before/after JSON per event is shown collapsed
// (<details>) rather than inline in the row, since it can be sizeable
// and most rows don't need it open to be useful.
function AuditExtractReportView({ report }: { report: Extract<ReportResponse, { key: 'audit-extract' }> }) {
  const { summary, rows } = report;
  return (
    <div className="flex flex-col gap-6">
      <div className="rounded border border-gray-200 p-3 sm:w-64">
        <p className="text-xs font-medium uppercase text-gray-500">Events</p>
        <p className="text-2xl font-semibold">{summary.totalEvents}</p>
      </div>

      <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
        <div>
          <h2 className="mb-2 text-sm font-semibold text-gray-700">By action</h2>
          <ul className="flex flex-col gap-1 text-sm">
            {summary.byAction.map((row) => (
              <li key={row.action} className="flex justify-between border-b border-gray-100 py-1">
                <span>{row.action}</span>
                <span className="font-medium">{row.count}</span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h2 className="mb-2 text-sm font-semibold text-gray-700">By entity</h2>
          <ul className="flex flex-col gap-1 text-sm">
            {summary.byEntity.map((row) => (
              <li key={row.entity} className="flex justify-between border-b border-gray-100 py-1">
                <span>{row.entity}</span>
                <span className="font-medium">{row.count}</span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h2 className="mb-2 text-sm font-semibold text-gray-700">Top actors</h2>
          {summary.topActors.length === 0 && <EmptyState message="No events in range." />}
          <ul className="flex flex-col gap-1 text-sm">
            {summary.topActors.map((row) => (
              <li key={row.actorId ?? 'system'} className="flex justify-between border-b border-gray-100 py-1">
                <span>{row.actorName}</span>
                <span className="font-medium">{row.count}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-gray-700">Events in range</h2>
        <div className="max-h-96 overflow-auto rounded border border-gray-200">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="sticky top-0 bg-white">
              <tr className="text-left text-xs font-medium uppercase text-gray-500">
                <th className="py-2 pr-4 pl-2">Timestamp</th>
                <th className="py-2 pr-4">Actor</th>
                <th className="py-2 pr-4">Action</th>
                <th className="py-2 pr-4">Entity</th>
                <th className="py-2 pr-4">Entity ID</th>
                <th className="py-2 pr-4">IP</th>
                <th className="py-2 pr-4">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="py-2 pr-4 pl-2">{new Date(row.createdAt).toLocaleString()}</td>
                  <td className="py-2 pr-4">{row.actorName}</td>
                  <td className="py-2 pr-4 font-medium">{row.action}</td>
                  <td className="py-2 pr-4">{row.entity}</td>
                  <td className="py-2 pr-4 font-mono text-xs">{row.entityId}</td>
                  <td className="py-2 pr-4">{row.ip ?? '—'}</td>
                  <td className="py-2 pr-4">
                    {(row.before || row.after) && (
                      <details>
                        <summary className="cursor-pointer text-xs text-blue-700">before/after</summary>
                        <pre className="mt-1 max-w-xs overflow-auto whitespace-pre-wrap text-xs text-gray-600">
                          {row.before ? `before: ${row.before}\n` : ''}
                          {row.after ? `after: ${row.after}` : ''}
                        </pre>
                      </details>
                    )}
                    {!row.before && !row.after && '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
