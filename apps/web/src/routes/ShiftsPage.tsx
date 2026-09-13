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

type FlagReason = 'NO_LOCATION' | 'OUTSIDE_ALL_GEOFENCES';

const FLAG_REASON_LABELS: Record<FlagReason, string> = {
  NO_LOCATION: 'No location captured',
  OUTSIDE_ALL_GEOFENCES: 'Outside every configured location',
};

interface TimeLogRow {
  id: string;
  userId: string;
  clockInAt: string;
  clockOutAt: string | null;
  clockInPhoto: TimeLogPhoto | null;
  clockOutPhoto: TimeLogPhoto | null;
  clockInLat: number | null;
  clockInLng: number | null;
  clockOutLat: number | null;
  clockOutLng: number | null;
  clockInFlagged: boolean;
  clockOutFlagged: boolean;
  clockInFlagReason: FlagReason | null;
  clockOutFlagReason: FlagReason | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  user: { id: string; fullName: string };
}

interface GeofenceRow {
  id: string;
  name: string;
  centerLat: number;
  centerLng: number;
  radiusMeters: number;
}

interface AssignableUser {
  id: string;
  fullName: string;
}

// No new dependency (spec §3: ask before adding one) — OpenStreetMap's
// own public embed page takes a bounding box + a marker and needs no
// API key. Tradeoff, flagged rather than hidden: this depends on
// osm.org's embed service staying up, can't draw the geofence radius
// on top of it, and isn't brandable — all fine at this app's scale (a
// 15-30 person internal tool, nowhere near OSM's "self-host your own
// tiles" heavy-traffic threshold), but worth knowing if that ever
// changes. A real interactive library (Leaflet) would fix all three at
// the cost of two new dependencies.
function locationMapUrl(lat: number, lng: number): string {
  const delta = 0.003; // roughly a 300-400m box around the pin
  const bbox = `${lng - delta}%2C${lat - delta}%2C${lng + delta}%2C${lat + delta}`;
  return `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat}%2C${lng}`;
}

function LocationMap({ lat, lng, label }: { lat: number; lng: number; label: string }) {
  return (
    <iframe
      title={label}
      src={locationMapUrl(lat, lng)}
      className="h-40 w-full rounded border border-gray-200"
      loading="lazy"
    />
  );
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

  // Client follow-up, 2026-09-13: warn the person in the moment rather
  // than only a reviewer finding out later. Location is captured first,
  // then checked against POST /dtr/check-location (booleans only, no
  // geofence data) — if it comes back flagged, window.confirm (same
  // cancel-or-continue pattern already used for every delete action in
  // this app) gives the person a chance to back out before anything is
  // uploaded or submitted. Continuing (or a clear check, or no
  // geofences configured at all) proceeds exactly as before: the real
  // clock-in/out re-evaluates the location server-side, authoritatively
  // — this pre-check is a UX convenience, never the source of truth.
  async function handleClock(kind: 'clock-in' | 'clock-out', file: File | null) {
    if (!file) {
      setError('A selfie photo is required.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const location = await captureLocation();
      const check = await api.post<{ flagged: boolean; reason: FlagReason | null }>(
        '/dtr/check-location',
        location ? { lat: location.lat, lng: location.lng } : {},
      );
      if (check.flagged) {
        const verb = kind === 'clock-in' ? 'Clock in' : 'Clock out';
        const proceed = window.confirm(`You appear to be outside a known work location. ${verb} anyway?`);
        if (!proceed) {
          setBusy(false);
          return;
        }
      }
      const uploaded = await api.upload<{ file: { id: string } }>('/files', file);
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
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {entry.clockInFlagged && (
                  <div className="flex flex-col gap-1">
                    <p className="text-xs font-semibold text-amber-900">
                      Clock-in: {entry.clockInFlagReason ? FLAG_REASON_LABELS[entry.clockInFlagReason] : 'Flagged'}
                    </p>
                    {entry.clockInPhoto && (
                      <a href={entry.clockInPhoto.url} target="_blank" rel="noreferrer" className="text-xs text-blue-700 hover:underline">
                        View clock-in photo
                      </a>
                    )}
                    {entry.clockInLat !== null && entry.clockInLng !== null && (
                      <LocationMap lat={entry.clockInLat} lng={entry.clockInLng} label={`${entry.user.fullName} clock-in location`} />
                    )}
                  </div>
                )}
                {entry.clockOutFlagged && (
                  <div className="flex flex-col gap-1">
                    <p className="text-xs font-semibold text-amber-900">
                      Clock-out: {entry.clockOutFlagReason ? FLAG_REASON_LABELS[entry.clockOutFlagReason] : 'Flagged'}
                    </p>
                    {entry.clockOutPhoto && (
                      <a href={entry.clockOutPhoto.url} target="_blank" rel="noreferrer" className="text-xs text-blue-700 hover:underline">
                        View clock-out photo
                      </a>
                    )}
                    {entry.clockOutLat !== null && entry.clockOutLng !== null && (
                      <LocationMap lat={entry.clockOutLat} lng={entry.clockOutLng} label={`${entry.user.fullName} clock-out location`} />
                    )}
                  </div>
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

const EMPTY_GEOFENCE_FORM = { name: '', centerLat: '', centerLng: '', radiusMeters: '' };

// Client follow-up, 2026-09-13: multiple named work locations replace
// the single geofence — "inside any one counts" for clock-in/out (see
// dtr/service.ts), so an admin can add, say, both "Main Resort" and a
// second address, and either one keeps a clock-in from being flagged.
function GeofenceManagementSection() {
  const [geofences, setGeofences] = useState<GeofenceRow[] | 'loading' | 'error'>('loading');
  const [form, setForm] = useState(EMPTY_GEOFENCE_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  function fetchGeofences() {
    setGeofences('loading');
    return api
      .get<{ geofences: GeofenceRow[] }>('/dtr/geofences')
      .then((res) => setGeofences(res.geofences))
      .catch(() => setGeofences('error'));
  }

  useEffect(() => {
    void fetchGeofences();
  }, []);

  function startEdit(geofence: GeofenceRow) {
    setEditingId(geofence.id);
    setFormError(null);
    setForm({
      name: geofence.name,
      centerLat: String(geofence.centerLat),
      centerLng: String(geofence.centerLng),
      radiusMeters: String(geofence.radiusMeters),
    });
  }

  function cancelEdit() {
    setEditingId(null);
    setFormError(null);
    setForm(EMPTY_GEOFENCE_FORM);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      const body = {
        name: form.name.trim(),
        centerLat: Number(form.centerLat),
        centerLng: Number(form.centerLng),
        radiusMeters: Number(form.radiusMeters),
      };
      if (editingId) {
        await api.patch(`/dtr/geofences/${editingId}`, body);
      } else {
        await api.post('/dtr/geofences', body);
      }
      setEditingId(null);
      setForm(EMPTY_GEOFENCE_FORM);
      await fetchGeofences();
    } catch (err) {
      setFormError(err instanceof ApiRequestError ? err.message : 'Could not save this work location.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(geofence: GeofenceRow) {
    if (!window.confirm(`Delete "${geofence.name}"? Clock-ins/outs will no longer be checked against it.`)) return;
    setActionError(null);
    try {
      await api.delete(`/dtr/geofences/${geofence.id}`);
      await fetchGeofences();
    } catch (err) {
      setActionError(err instanceof ApiRequestError ? err.message : 'Could not delete this work location.');
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-base font-semibold">DTR work locations</h2>
      <p className="text-sm text-gray-500">
        A clock-in/out is only flagged if it falls outside every location below — any one of them counts, and it
        works the same for everyone, not tied to a specific employee. Leave this list empty to never flag for
        location reasons.
      </p>

      {actionError && (
        <p role="alert" className="text-sm text-red-700">
          {actionError}
        </p>
      )}

      {geofences === 'loading' && (
        <table className="w-full text-sm">
          <tbody>
            <SkeletonTableRows rows={2} columns={5} />
          </tbody>
        </table>
      )}
      {geofences === 'error' && <p role="alert">Could not load work locations.</p>}
      {Array.isArray(geofences) && geofences.length === 0 && <EmptyState message="No work locations configured yet." />}
      {Array.isArray(geofences) && geofences.length > 0 && (
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-gray-500">
                <th className="py-2 pr-4 font-medium">Name</th>
                <th className="py-2 pr-4 font-medium">Latitude</th>
                <th className="py-2 pr-4 font-medium">Longitude</th>
                <th className="py-2 pr-4 font-medium">Radius (m)</th>
                <th className="py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {geofences.map((geofence) => (
                <tr key={geofence.id} className="border-b border-gray-100">
                  <td className="py-2 pr-4 font-medium">{geofence.name}</td>
                  <td className="py-2 pr-4">{geofence.centerLat}</td>
                  <td className="py-2 pr-4">{geofence.centerLng}</td>
                  <td className="py-2 pr-4">{geofence.radiusMeters}</td>
                  <td className="py-2">
                    <div className="flex gap-3">
                      <button type="button" onClick={() => startEdit(geofence)} className="text-sm text-blue-700 hover:underline">
                        Edit
                      </button>
                      <button type="button" onClick={() => void handleDelete(geofence)} className="text-sm text-red-700 hover:underline">
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-3 rounded border border-gray-200 p-4">
        <h3 className="text-sm font-semibold">{editingId ? 'Edit work location' : 'Add a work location'}</h3>
        {formError && (
          <p role="alert" className="text-sm text-red-700">
            {formError}
          </p>
        )}
        <label className="flex flex-col gap-1 text-sm">
          Name
          <input
            required
            placeholder="e.g. Main Resort"
            className="rounded border border-gray-300 px-2 py-1"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          />
        </label>
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
        <div className="flex gap-3">
          <button
            type="submit"
            disabled={submitting}
            className="w-fit rounded bg-blue-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {submitting ? 'Saving…' : editingId ? 'Save changes' : 'Add location'}
          </button>
          {editingId && (
            <button type="button" onClick={cancelEdit} className="w-fit rounded border border-gray-300 px-4 py-2 text-sm font-medium">
              Cancel
            </button>
          )}
        </div>
      </form>
    </section>
  );
}

function defaultAuditRange() {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 13); // last 14 days, inclusive of today
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { from: iso(from), to: iso(to) };
}

// Client follow-up, 2026-09-13: a general audit view for a shift:manage
// holder to browse every clock-in/out, selfie + map included — not
// just the flagged exceptions above. Bounded by date range (defaults to
// the last 14 days) so it never fetches the property's entire DTR
// history unbounded as the pilot accumulates data; the employee filter
// reuses GET /shifts/assignable-users, the same shift:manage-gated
// picker built for (and currently dormant in) the roster module — see
// spec.md §13 decision 9.
function AllTimeLogsSection() {
  const [range, setRange] = useState(defaultAuditRange);
  const [userId, setUserId] = useState('');
  const [users, setUsers] = useState<AssignableUser[]>([]);
  const [logs, setLogs] = useState<TimeLogRow[] | 'loading' | 'error'>('loading');
  const [noteById, setNoteById] = useState<Record<string, string>>({});
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ users: AssignableUser[] }>('/shifts/assignable-users')
      .then((res) => setUsers(res.users))
      .catch(() => setUsers([]));
  }, []);

  function fetchLogs() {
    setLogs('loading');
    const params = new URLSearchParams({ from: range.from, to: range.to });
    if (userId) params.set('userId', userId);
    return api
      .get<{ timeLogs: TimeLogRow[] }>(`/time-logs?${params.toString()}`)
      .then((res) => setLogs(res.timeLogs))
      .catch(() => setLogs('error'));
  }

  useEffect(() => {
    void fetchLogs();
  }, [range.from, range.to, userId]);

  async function review(id: string) {
    setActionError(null);
    try {
      await api.post(`/time-logs/${id}/review`, { reviewNote: noteById[id]?.trim() || undefined });
      await fetchLogs();
    } catch (err) {
      setActionError(err instanceof ApiRequestError ? err.message : 'Could not mark this entry reviewed.');
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-base font-semibold">All time logs</h2>
      <p className="text-sm text-gray-500">
        Every clock-in/out in range, not just flagged ones — Flagged Entries above is for exceptions needing a
        decision; this is the full record, for a look at any time.
      </p>

      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1 text-sm">
          From
          <input
            type="date"
            className="rounded border border-gray-300 px-2 py-1"
            value={range.from}
            onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          To
          <input
            type="date"
            className="rounded border border-gray-300 px-2 py-1"
            value={range.to}
            onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Employee
          <select
            className="rounded border border-gray-300 px-2 py-1"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
          >
            <option value="">Everyone</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.fullName}
              </option>
            ))}
          </select>
        </label>
      </div>

      {actionError && (
        <p role="alert" className="text-sm text-red-700">
          {actionError}
        </p>
      )}

      {logs === 'loading' && (
        <table className="w-full text-sm">
          <tbody>
            <SkeletonTableRows rows={3} columns={4} />
          </tbody>
        </table>
      )}
      {logs === 'error' && <p role="alert">Could not load time logs.</p>}
      {Array.isArray(logs) && logs.length === 0 && <EmptyState message="No time logs in this range." />}
      {Array.isArray(logs) && logs.length > 0 && (
        <div className="flex flex-col gap-3">
          {logs.map((log) => {
            const isFlagged = log.clockInFlagged || log.clockOutFlagged;
            return (
              <div key={log.id} className="flex flex-col gap-2 rounded border border-gray-200 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium">
                    {log.user.fullName} — {formatDateTime(log.clockInAt)}
                    {log.clockOutAt ? ` to ${formatDateTime(log.clockOutAt)}` : ' (still clocked in)'}
                  </p>
                  <span
                    className={
                      !isFlagged
                        ? 'rounded border border-gray-300 bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-700'
                        : log.reviewedAt
                          ? 'rounded border border-green-300 bg-green-100 px-2 py-0.5 text-xs font-semibold text-green-900'
                          : 'rounded border border-amber-300 bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900'
                    }
                  >
                    {!isFlagged ? 'Normal' : log.reviewedAt ? 'Reviewed' : 'Flagged'}
                  </span>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="flex flex-col gap-1">
                    <p className="text-xs font-semibold text-gray-600">Clock-in</p>
                    {log.clockInPhoto && (
                      <a href={log.clockInPhoto.url} target="_blank" rel="noreferrer" className="text-xs text-blue-700 hover:underline">
                        View photo
                      </a>
                    )}
                    {log.clockInLat !== null && log.clockInLng !== null ? (
                      <LocationMap lat={log.clockInLat} lng={log.clockInLng} label={`${log.user.fullName} clock-in location`} />
                    ) : (
                      <p className="text-xs text-gray-400">No location captured</p>
                    )}
                  </div>
                  <div className="flex flex-col gap-1">
                    <p className="text-xs font-semibold text-gray-600">Clock-out</p>
                    {log.clockOutPhoto && (
                      <a href={log.clockOutPhoto.url} target="_blank" rel="noreferrer" className="text-xs text-blue-700 hover:underline">
                        View photo
                      </a>
                    )}
                    {log.clockOutLat !== null && log.clockOutLng !== null ? (
                      <LocationMap lat={log.clockOutLat} lng={log.clockOutLng} label={`${log.user.fullName} clock-out location`} />
                    ) : (
                      <p className="text-xs text-gray-400">{log.clockOutAt ? 'No location captured' : 'Not clocked out yet'}</p>
                    )}
                  </div>
                </div>
                {isFlagged && !log.reviewedAt && (
                  <>
                    <label className="flex flex-col gap-1 text-sm">
                      Review note (optional)
                      <input
                        className="rounded border border-gray-300 px-2 py-1"
                        value={noteById[log.id] ?? ''}
                        onChange={(e) => setNoteById((prev) => ({ ...prev, [log.id]: e.target.value }))}
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => void review(log.id)}
                      className="w-fit rounded bg-blue-700 px-3 py-1.5 text-xs font-medium text-white"
                    >
                      Mark reviewed
                    </button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
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
      {canManageShifts && <AllTimeLogsSection />}
      {canConfigureGeofence && <GeofenceManagementSection />}
    </div>
  );
}
