import { DEPARTMENT_KEYS, REPORT_KEYS, REPORT_LABELS, type DepartmentKey, type ReportKey } from '@lwwbr/shared';
import { useState, type FormEvent } from 'react';
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

type ReportResponse =
  | { key: 'occupancy'; from: string; to: string; summary: OccupancySummary; rows: OccupancyRow[] }
  | { key: 'work-orders'; from: string; to: string; summary: WorkOrderSummary; rows: WorkOrderRow[] }
  | { key: 'housekeeping'; from: string; to: string; summary: HousekeepingSummary; rows: HousekeepingRow[] };

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

      {report?.key === 'occupancy' && <OccupancyReportView report={report} />}
      {report?.key === 'work-orders' && <WorkOrderReportView report={report} />}
      {report?.key === 'housekeeping' && <HousekeepingReportView report={report} />}
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
        {summary.topRecurringUnits.length === 0 && <p className="text-sm text-gray-500">No unit-linked tickets in range.</p>}
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
        {summary.byAttendant.length === 0 && <p className="text-sm text-gray-500">No completed cleans in range.</p>}
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
