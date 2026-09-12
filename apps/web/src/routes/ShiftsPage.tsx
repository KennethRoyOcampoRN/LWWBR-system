import { REST_DAY_STATUS_LABELS, type RestDayStatusKey } from '@lwwbr/shared';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { EmptyState } from '../components/EmptyState.js';
import { SkeletonTableRows } from '../components/Skeleton.js';
import { useAuth } from '../context/AuthContext.js';
import { api, ApiRequestError } from '../lib/api.js';

// Client-directed feature, 2026-09-18: DTR (time in/out with selfie +
// geolocation capture) and rest-day requests, in one standalone page —
// not surfaced on Command Center. See the backend modules' own header
// comments (dtr/service.ts, restday/service.ts) for the real design
// decisions: never-block-only-flag for the geofence check, self-
// scoping for DTR/rest-day requests without a dedicated permission
// key. Client decision, 2026-09-12 (spec.md §13 decision 9): the
// Shift-roster UI that used to live here was removed — scheduling is
// handled manually outside the app — but the `Shift` model, its
// `shift:manage` grants, and the backend `shifts` module stay in
// place, untouched and dormant, since `shift:manage` still gates
// Flagged Entries review below.

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

function TimeClockSection() {
  const [myLogs, setMyLogs] = useState<TimeLogRow[] | 'loading' | 'error'>('loading');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clockInInputRef = useRef<HTMLInputElement>(null);
  const clockOutInputRef = useRef<HTMLInputElement>(null);

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
        Tap the button, take a selfie, and the time is recorded automatically — there's nothing to type. Location is
        captured automatically if your browser allows it, but it's never required to clock in or out.
      </p>

      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}

      <div className="flex flex-col gap-3 rounded border border-gray-200 p-4">
        {openEntry ? (
          <>
            <p className="text-sm">Clocked in at {formatDateTime(openEntry.clockInAt)}</p>
            {/* The button is what the person sees and taps; the actual
                mechanism is the hidden file input below it, opened via
                ref — same capture="user" behavior as before, just not
                presented as a raw file-chooser control. The time itself
                is never taken from this input: the server stamps
                clockOutAt with its own "now" the moment the request
                completes (see dtr/service.ts), so there is nothing here
                for a person to set or get wrong. */}
            <button
              type="button"
              disabled={busy}
              onClick={() => clockOutInputRef.current?.click()}
              className="w-full rounded-lg bg-red-700 px-6 py-4 text-lg font-semibold text-white disabled:opacity-50 sm:w-fit"
            >
              {busy ? 'Working…' : 'Clock out'}
            </button>
            {/* capture="user" pushes mobile browsers straight into the
                front-facing camera instead of the gallery/file picker
                — a live photo, not an old one. This is a mobile
                browser behavior, not a hard guarantee: desktop
                browsers generally ignore `capture` and still show a
                normal file picker, so this alone doesn't stop someone
                on a desktop from uploading an existing image. */}
            <input
              ref={clockOutInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/heic"
              capture="user"
              disabled={busy}
              aria-label="Clock-out selfie"
              className="sr-only"
              onChange={(e) => void handleClock('clock-out', e.target.files?.[0] ?? null)}
            />
          </>
        ) : (
          <>
            {/* Same pattern as clock-out above: a real button up front,
                the file input (and its "now" timestamp, set server-
                side) is purely the mechanism behind it. */}
            <button
              type="button"
              disabled={busy}
              onClick={() => clockInInputRef.current?.click()}
              className="w-full rounded-lg bg-blue-700 px-6 py-4 text-lg font-semibold text-white disabled:opacity-50 sm:w-fit"
            >
              {busy ? 'Working…' : 'Clock in'}
            </button>
            <input
              ref={clockInInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/heic"
              capture="user"
              disabled={busy}
              aria-label="Clock-in selfie"
              className="sr-only"
              onChange={(e) => void handleClock('clock-in', e.target.files?.[0] ?? null)}
            />
          </>
        )}
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
        <p className="text-sm text-gray-500">Time in/out and rest-day requests.</p>
      </div>

      {/* Client follow-up, 2026-09-12: Time Clock moved to the top — the
          one thing every employee needs daily, ahead of the
          rest-day/admin-only sections below. Client decision, same day
          (spec.md §13 decision 9): the Shift-roster section that used
          to render here is gone — scheduling is manual, outside the
          app — but shift:manage still gates Flagged Entries below. */}
      <TimeClockSection />
      <RestDaySection canApprove={canApproveRestDay} />
      {canManageShifts && <FlaggedEntriesSection />}
      {canConfigureGeofence && <GeofenceSettingsSection />}
    </div>
  );
}
