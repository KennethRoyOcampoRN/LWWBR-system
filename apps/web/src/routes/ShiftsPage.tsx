import { DEPARTMENT_KEYS, REST_DAY_STATUS_LABELS, type DepartmentKey, type RestDayStatusKey } from '@lwwbr/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { EmptyState } from '../components/EmptyState.js';
import { SkeletonTableRows } from '../components/Skeleton.js';
import { useAuth } from '../context/AuthContext.js';
import { api, ApiRequestError } from '../lib/api.js';
import { DEPARTMENT_LABELS } from '../lib/workOrderStyle.js';

// Client-directed feature, 2026-09-18: Shift roster + reliever
// assignment, DTR (time in/out with selfie + geolocation capture), and
// rest-day requests, all in one standalone page — not surfaced on
// Command Center. See the backend modules' own header comments
// (shifts/service.ts, dtr/service.ts, restday/service.ts) for the real
// design decisions: soft-delete for roster cancellation, never-block-
// only-flag for the geofence check, self-scoping for DTR/rest-day
// requests without a dedicated permission key.

interface AssignableUser {
  id: string;
  fullName: string;
  employeeCode: string;
  department: DepartmentKey;
}

interface ShiftRow {
  id: string;
  date: string;
  startTime: string;
  endTime: string;
  department: DepartmentKey;
  isReliever: boolean;
  note: string | null;
  user: { id: string; fullName: string };
}

interface TimeLogPhoto {
  id: string;
  filename: string;
  url: string;
}

interface TimeLogRow {
  id: string;
  userId: string;
  clockInAt: string;
  clockOutAt: string | null;
  clockInPhoto: TimeLogPhoto | null;
  clockOutPhoto: TimeLogPhoto | null;
  clockInFlagged: boolean;
  clockOutFlagged: boolean;
  reviewedAt: string | null;
  reviewNote: string | null;
  user: { id: string; fullName: string };
}

interface RestDayRequestRow {
  id: string;
  requestedDate: string;
  reason: string | null;
  status: RestDayStatusKey;
  decisionNote: string | null;
  user: { fullName: string };
  decidedBy: { fullName: string } | null;
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString();
}

// Never throws, never blocks the caller — a denied/failed/unsupported
// geolocation call resolves to null rather than rejecting, so a clock-
// in/out can always proceed without it (see dtr/service.ts's own header
// comment for why: the entry gets flagged for review instead of being
// refused outright).
function captureLocation(): Promise<{ lat: number; lng: number } | null> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({ lat: position.coords.latitude, lng: position.coords.longitude }),
      () => resolve(null),
      { timeout: 8000 },
    );
  });
}

function ShiftRosterSection({ canManage }: { canManage: boolean }) {
  const [shifts, setShifts] = useState<ShiftRow[] | 'loading' | 'error'>('loading');
  const [assignableUsers, setAssignableUsers] = useState<AssignableUser[]>([]);
  const [form, setForm] = useState({
    userId: '',
    date: '',
    startTime: '',
    endTime: '',
    department: 'HOUSEKEEPING' as DepartmentKey,
    isReliever: false,
    note: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  function fetchShifts() {
    setShifts('loading');
    return api
      .get<{ shifts: ShiftRow[] }>('/shifts')
      .then((res) => setShifts(res.shifts))
      .catch(() => setShifts('error'));
  }

  useEffect(() => {
    void fetchShifts();
  }, []);

  useEffect(() => {
    if (!canManage) return;
    api
      .get<{ users: AssignableUser[] }>('/shifts/assignable-users')
      .then((res) => setAssignableUsers(res.users))
      .catch(() => setAssignableUsers([]));
  }, [canManage]);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      const dateIso = new Date(form.date).toISOString();
      await api.post('/shifts', {
        userId: form.userId,
        date: dateIso,
        startTime: new Date(`${form.date}T${form.startTime}`).toISOString(),
        endTime: new Date(`${form.date}T${form.endTime}`).toISOString(),
        department: form.department,
        isReliever: form.isReliever,
        note: form.note.trim() || undefined,
      });
      setForm({ userId: '', date: '', startTime: '', endTime: '', department: 'HOUSEKEEPING', isReliever: false, note: '' });
      await fetchShifts();
    } catch (err) {
      setFormError(err instanceof ApiRequestError ? err.message : 'Could not create the shift.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(shift: ShiftRow) {
    if (!window.confirm(`Cancel the shift for ${shift.user.fullName} on ${formatDate(shift.date)}?`)) return;
    try {
      await api.delete(`/shifts/${shift.id}`);
      await fetchShifts();
    } catch {
      // A failed cancel just leaves the row in place — the manager can
      // retry; no dedicated error slot for a low-stakes list action.
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-base font-semibold">Shift roster</h2>

      {shifts === 'loading' && (
        <table className="w-full text-sm">
          <tbody>
            <SkeletonTableRows rows={4} columns={6} />
          </tbody>
        </table>
      )}
      {shifts === 'error' && <p role="alert">Could not load the shift roster.</p>}
      {Array.isArray(shifts) && shifts.length === 0 && <EmptyState message="No shifts scheduled yet." />}
      {Array.isArray(shifts) && shifts.length > 0 && (
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-gray-500">
                <th className="py-2 pr-4 font-medium">Employee</th>
                <th className="py-2 pr-4 font-medium">Date</th>
                <th className="py-2 pr-4 font-medium">Time</th>
                <th className="py-2 pr-4 font-medium">Department</th>
                <th className="py-2 pr-4 font-medium">Reliever</th>
                {canManage && <th className="py-2 font-medium">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {shifts.map((shift) => (
                <tr key={shift.id} className="border-b border-gray-100">
                  <td className="py-2 pr-4 font-medium">{shift.user.fullName}</td>
                  <td className="py-2 pr-4">{formatDate(shift.date)}</td>
                  <td className="py-2 pr-4">
                    {new Date(shift.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} –{' '}
                    {new Date(shift.endTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </td>
                  <td className="py-2 pr-4">{DEPARTMENT_LABELS[shift.department]}</td>
                  <td className="py-2 pr-4">{shift.isReliever ? 'Reliever' : '—'}</td>
                  {canManage && (
                    <td className="py-2">
                      <button
                        type="button"
                        onClick={() => void handleDelete(shift)}
                        className="text-sm text-red-700 hover:underline"
                      >
                        Cancel
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canManage && (
        <form onSubmit={(e) => void handleCreate(e)} className="flex flex-col gap-3 rounded border border-gray-200 p-4">
          <h3 className="text-sm font-semibold">Add a shift</h3>
          {formError && (
            <p role="alert" className="text-sm text-red-700">
              {formError}
            </p>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm">
              Employee
              <select
                required
                className="rounded border border-gray-300 px-2 py-1"
                value={form.userId}
                onChange={(e) => setForm((f) => ({ ...f, userId: e.target.value }))}
              >
                <option value="">Select…</option>
                {assignableUsers.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.fullName}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Department
              <select
                className="rounded border border-gray-300 px-2 py-1"
                value={form.department}
                onChange={(e) => setForm((f) => ({ ...f, department: e.target.value as DepartmentKey }))}
              >
                {DEPARTMENT_KEYS.map((key) => (
                  <option key={key} value={key}>
                    {DEPARTMENT_LABELS[key]}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Date
              <input
                required
                type="date"
                className="rounded border border-gray-300 px-2 py-1"
                value={form.date}
                onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
              />
            </label>
            <div />
            <label className="flex flex-col gap-1 text-sm">
              Start time
              <input
                required
                type="time"
                className="rounded border border-gray-300 px-2 py-1"
                value={form.startTime}
                onChange={(e) => setForm((f) => ({ ...f, startTime: e.target.value }))}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              End time
              <input
                required
                type="time"
                className="rounded border border-gray-300 px-2 py-1"
                value={form.endTime}
                onChange={(e) => setForm((f) => ({ ...f, endTime: e.target.value }))}
              />
            </label>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.isReliever}
              onChange={(e) => setForm((f) => ({ ...f, isReliever: e.target.checked }))}
            />
            This shift is a reliever covering for someone
          </label>
          <button
            type="submit"
            disabled={submitting}
            className="w-fit rounded bg-blue-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {submitting ? 'Adding…' : 'Add shift'}
          </button>
        </form>
      )}
    </section>
  );
}

function TimeClockSection() {
  const [myLogs, setMyLogs] = useState<TimeLogRow[] | 'loading' | 'error'>('loading');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function fetchMyLogs() {
    setMyLogs('loading');
    return api
      .get<{ timeLogs: TimeLogRow[] }>('/time-logs')
      .then((res) => setMyLogs(res.timeLogs))
      .catch(() => setMyLogs('error'));
  }

  useEffect(() => {
    void fetchMyLogs();
  }, []);

  const openEntry = Array.isArray(myLogs) ? myLogs.find((log) => !log.clockOutAt) : undefined;

  async function handleClock(kind: 'clock-in' | 'clock-out', file: File | null) {
    if (!file) {
      setError('A selfie photo is required.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const uploaded = await api.upload<{ file: { id: string } }>('/files', file);
      const location = await captureLocation();
      await api.post(`/time-logs/${kind}`, {
        photoFileId: uploaded.file.id,
        ...(location ? { lat: location.lat, lng: location.lng } : {}),
      });
      await fetchMyLogs();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : `Could not ${kind === 'clock-in' ? 'clock in' : 'clock out'}.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-base font-semibold">Time clock</h2>
      <p className="text-sm text-gray-500">
        A selfie photo is required on both clock-in and clock-out. Location is captured automatically if your
        browser allows it — it's never required to clock in or out.
      </p>

      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}

      <div className="flex flex-col gap-2 rounded border border-gray-200 p-4">
        {openEntry ? (
          <>
            <p className="text-sm">Clocked in at {formatDateTime(openEntry.clockInAt)}</p>
            <label className="flex flex-col gap-1 text-sm">
              Clock-out selfie
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp,image/heic"
                disabled={busy}
                onChange={(e) => void handleClock('clock-out', e.target.files?.[0] ?? null)}
              />
            </label>
          </>
        ) : (
          <label className="flex flex-col gap-1 text-sm">
            Clock-in selfie
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,image/heic"
              disabled={busy}
              onChange={(e) => void handleClock('clock-in', e.target.files?.[0] ?? null)}
            />
          </label>
        )}
        {busy && <p className="text-xs text-gray-500">Working…</p>}
      </div>

      <h3 className="text-sm font-semibold">My recent time logs</h3>
      {myLogs === 'loading' && (
        <table className="w-full text-sm">
          <tbody>
            <SkeletonTableRows rows={3} columns={4} />
          </tbody>
        </table>
      )}
      {myLogs === 'error' && <p role="alert">Could not load your time logs.</p>}
      {Array.isArray(myLogs) && myLogs.length === 0 && <EmptyState message="No time logs yet." />}
      {Array.isArray(myLogs) && myLogs.length > 0 && (
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-gray-500">
                <th className="py-2 pr-4 font-medium">Clock in</th>
                <th className="py-2 pr-4 font-medium">Clock out</th>
                <th className="py-2 pr-4 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {myLogs.map((log) => (
                <tr key={log.id} className="border-b border-gray-100">
                  <td className="py-2 pr-4">{formatDateTime(log.clockInAt)}</td>
                  <td className="py-2 pr-4">{log.clockOutAt ? formatDateTime(log.clockOutAt) : '—'}</td>
                  <td className="py-2 pr-4">
                    {log.clockInFlagged || log.clockOutFlagged ? (
                      <span className="rounded border border-amber-300 bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900">
                        Flagged for review
                      </span>
                    ) : (
                      'Normal'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function RestDaySection({ canApprove }: { canApprove: boolean }) {
  const [requests, setRequests] = useState<RestDayRequestRow[] | 'loading' | 'error'>('loading');
  const [form, setForm] = useState({ requestedDate: '', reason: '' });
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  function fetchRequests() {
    setRequests('loading');
    return api
      .get<{ restDayRequests: RestDayRequestRow[] }>('/restday-requests')
      .then((res) => setRequests(res.restDayRequests))
      .catch(() => setRequests('error'));
  }

  useEffect(() => {
    void fetchRequests();
  }, []);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      await api.post('/restday-requests', {
        requestedDate: new Date(form.requestedDate).toISOString(),
        reason: form.reason.trim() || undefined,
      });
      setForm({ requestedDate: '', reason: '' });
      await fetchRequests();
    } catch (err) {
      setFormError(err instanceof ApiRequestError ? err.message : 'Could not submit the request.');
    } finally {
      setSubmitting(false);
    }
  }

  async function decide(id: string, toStatus: 'APPROVED' | 'REJECTED') {
    setActionError(null);
    try {
      await api.post(`/restday-requests/${id}/status`, { toStatus });
      await fetchRequests();
    } catch (err) {
      setActionError(err instanceof ApiRequestError ? err.message : 'Could not update the request.');
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-base font-semibold">Rest-day requests</h2>

      {actionError && (
        <p role="alert" className="text-sm text-red-700">
          {actionError}
        </p>
      )}

      {requests === 'loading' && (
        <table className="w-full text-sm">
          <tbody>
            <SkeletonTableRows rows={3} columns={5} />
          </tbody>
        </table>
      )}
      {requests === 'error' && <p role="alert">Could not load rest-day requests.</p>}
      {Array.isArray(requests) && requests.length === 0 && <EmptyState message="No rest-day requests yet." />}
      {Array.isArray(requests) && requests.length > 0 && (
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-gray-500">
                {canApprove && <th className="py-2 pr-4 font-medium">Employee</th>}
                <th className="py-2 pr-4 font-medium">Requested date</th>
                <th className="py-2 pr-4 font-medium">Reason</th>
                <th className="py-2 pr-4 font-medium">Status</th>
                {canApprove && <th className="py-2 font-medium">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {requests.map((req) => (
                <tr key={req.id} className="border-b border-gray-100">
                  {canApprove && <td className="py-2 pr-4 font-medium">{req.user.fullName}</td>}
                  <td className="py-2 pr-4">{formatDate(req.requestedDate)}</td>
                  <td className="py-2 pr-4">{req.reason ?? '—'}</td>
                  <td className="py-2 pr-4">{REST_DAY_STATUS_LABELS[req.status]}</td>
                  {canApprove && (
                    <td className="py-2">
                      {req.status === 'PENDING' && (
                        <div className="flex gap-3">
                          <button
                            type="button"
                            onClick={() => void decide(req.id, 'APPROVED')}
                            className="text-sm text-blue-700 hover:underline"
                          >
                            Approve
                          </button>
                          <button
                            type="button"
                            onClick={() => void decide(req.id, 'REJECTED')}
                            className="text-sm text-red-700 hover:underline"
                          >
                            Reject
                          </button>
                        </div>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <form onSubmit={(e) => void handleCreate(e)} className="flex flex-col gap-3 rounded border border-gray-200 p-4">
        <h3 className="text-sm font-semibold">Request a rest day</h3>
        {formError && (
          <p role="alert" className="text-sm text-red-700">
            {formError}
          </p>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            Date
            <input
              required
              type="date"
              className="rounded border border-gray-300 px-2 py-1"
              value={form.requestedDate}
              onChange={(e) => setForm((f) => ({ ...f, requestedDate: e.target.value }))}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Reason (optional)
            <input
              className="rounded border border-gray-300 px-2 py-1"
              value={form.reason}
              onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
            />
          </label>
        </div>
        <button
          type="submit"
          disabled={submitting}
          className="w-fit rounded bg-blue-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {submitting ? 'Submitting…' : 'Submit request'}
        </button>
      </form>
    </section>
  );
}

function FlaggedEntriesSection() {
  const [entries, setEntries] = useState<TimeLogRow[] | 'loading' | 'error'>('loading');
  const [noteById, setNoteById] = useState<Record<string, string>>({});
  const [actionError, setActionError] = useState<string | null>(null);

  function fetchFlagged() {
    setEntries('loading');
    return api
      .get<{ timeLogs: TimeLogRow[] }>('/time-logs/flagged')
      .then((res) => setEntries(res.timeLogs))
      .catch(() => setEntries('error'));
  }

  useEffect(() => {
    void fetchFlagged();
  }, []);

  async function review(id: string) {
    setActionError(null);
    try {
      await api.post(`/time-logs/${id}/review`, { reviewNote: noteById[id]?.trim() || undefined });
      await fetchFlagged();
    } catch (err) {
      setActionError(err instanceof ApiRequestError ? err.message : 'Could not mark this entry reviewed.');
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-base font-semibold">Flagged time entries</h2>
      <p className="text-sm text-gray-500">
        Clock-ins/outs outside the configured geofence, or with no location captured — never blocked, just held
        here for a look.
      </p>

      {actionError && (
        <p role="alert" className="text-sm text-red-700">
          {actionError}
        </p>
      )}

      {entries === 'loading' && (
        <table className="w-full text-sm">
          <tbody>
            <SkeletonTableRows rows={2} columns={5} />
          </tbody>
        </table>
      )}
      {entries === 'error' && <p role="alert">Could not load flagged entries.</p>}
      {Array.isArray(entries) && entries.length === 0 && <EmptyState message="No flagged entries." />}
      {Array.isArray(entries) && entries.length > 0 && (
        <div className="flex flex-col gap-3">
          {entries.map((entry) => (
            <div key={entry.id} className="flex flex-col gap-2 rounded border border-amber-300 bg-amber-50 p-4">
              <p className="text-sm font-medium">
                {entry.user.fullName} — {formatDateTime(entry.clockInAt)}
                {entry.clockOutAt ? ` to ${formatDateTime(entry.clockOutAt)}` : ' (still clocked in)'}
              </p>
              <div className="flex gap-4 text-xs text-gray-600">
                {entry.clockInFlagged && entry.clockInPhoto && (
                  <a href={entry.clockInPhoto.url} target="_blank" rel="noreferrer" className="text-blue-700 hover:underline">
                    View clock-in photo
                  </a>
                )}
                {entry.clockOutFlagged && entry.clockOutPhoto && (
                  <a href={entry.clockOutPhoto.url} target="_blank" rel="noreferrer" className="text-blue-700 hover:underline">
                    View clock-out photo
                  </a>
                )}
              </div>
              <label className="flex flex-col gap-1 text-sm">
                Review note (optional)
                <input
                  className="rounded border border-gray-300 px-2 py-1"
                  value={noteById[entry.id] ?? ''}
                  onChange={(e) => setNoteById((prev) => ({ ...prev, [entry.id]: e.target.value }))}
                />
              </label>
              <button
                type="button"
                onClick={() => void review(entry.id)}
                className="w-fit rounded bg-blue-700 px-3 py-1.5 text-xs font-medium text-white"
              >
                Mark reviewed
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function GeofenceSettingsSection() {
  const [form, setForm] = useState({ centerLat: '', centerLng: '', radiusMeters: '' });
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api
      .get<{ geofence: { centerLat: number; centerLng: number; radiusMeters: number } | null }>('/dtr/geofence-setting')
      .then((res) => {
        if (res.geofence) {
          setForm({
            centerLat: String(res.geofence.centerLat),
            centerLng: String(res.geofence.centerLng),
            radiusMeters: String(res.geofence.radiusMeters),
          });
        }
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setSaving(true);
    try {
      await api.put('/dtr/geofence-setting', {
        centerLat: Number(form.centerLat),
        centerLng: Number(form.centerLng),
        radiusMeters: Number(form.radiusMeters),
      });
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not save the geofence.');
    } finally {
      setSaving(false);
    }
  }

  if (!loaded) return null;

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-base font-semibold">DTR geofence</h2>
      <p className="text-sm text-gray-500">
        A clock-in/out outside this radius is never blocked — it's flagged for review instead.
      </p>
      <form onSubmit={(e) => void handleSave(e)} className="flex flex-col gap-3 rounded border border-gray-200 p-4">
        {error && (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        )}
        {saved && <p className="text-sm text-green-700">Saved.</p>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className="flex flex-col gap-1 text-sm">
            Center latitude
            <input
              required
              type="number"
              step="any"
              className="rounded border border-gray-300 px-2 py-1"
              value={form.centerLat}
              onChange={(e) => setForm((f) => ({ ...f, centerLat: e.target.value }))}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Center longitude
            <input
              required
              type="number"
              step="any"
              className="rounded border border-gray-300 px-2 py-1"
              value={form.centerLng}
              onChange={(e) => setForm((f) => ({ ...f, centerLng: e.target.value }))}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Radius (meters)
            <input
              required
              type="number"
              min="1"
              className="rounded border border-gray-300 px-2 py-1"
              value={form.radiusMeters}
              onChange={(e) => setForm((f) => ({ ...f, radiusMeters: e.target.value }))}
            />
          </label>
        </div>
        <button
          type="submit"
          disabled={saving}
          className="w-fit rounded bg-blue-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save geofence'}
        </button>
      </form>
    </section>
  );
}

export function ShiftsPage() {
  const { user } = useAuth();
  const canManageShifts = Boolean(user?.permissions['shift:manage']);
  const canApproveRestDay = Boolean(user?.permissions['restday:approve']);
  const canConfigureGeofence = Boolean(user?.permissions['system:configure']);

  return (
    <div className="flex flex-col gap-10">
      <div>
        <h1 className="text-lg font-semibold">Shifts & DTR</h1>
        <p className="text-sm text-gray-500">
          Shift roster, reliever assignment, time in/out, and rest-day requests.
        </p>
      </div>

      <ShiftRosterSection canManage={canManageShifts} />
      <TimeClockSection />
      <RestDaySection canApprove={canApproveRestDay} />
      {canManageShifts && <FlaggedEntriesSection />}
      {canConfigureGeofence && <GeofenceSettingsSection />}
    </div>
  );
}
