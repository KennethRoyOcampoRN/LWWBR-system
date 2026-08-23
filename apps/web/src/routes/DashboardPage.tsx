import type { UnitStatusKey } from '@lwwbr/shared';
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext.js';
import { api } from '../lib/api.js';
import { subscribeToUnitStatusChanges } from '../lib/realtime.js';
import { UNIT_STATUS_LABELS } from '../lib/unitStatusStyle.js';

// Spec §8.2's Command Center, built incrementally: task 14 already shipped
// the unit grid (its own page, /units) and the realtime
// unit.status.changed broadcast it relies on. This page adds the other
// three widgets §8.2 lists around that grid — KPI strip, live activity
// feed, attention queue — reusing that same broadcast rather than a
// second realtime channel.
const FEED_LIMIT = 20;
const MAX_FEED_ITEMS = 30;

interface DashboardData {
  kpi: { occupied: number; ready: number; dirty: number; outOfOrder: number };
  dirtyRooms: { id: string; code: string; name: string; dirtyMinutes: number }[];
}

interface RawActivityEvent {
  id: string;
  unitCode: string;
  unitName: string;
  fromStatus: UnitStatusKey;
  toStatus: UnitStatusKey;
  note: string | null;
  actorName: string;
  createdAt: string;
}

// A common shape for both the backfilled history (GET /units/activity)
// and a live unit.status.changed broadcast, so the feed doesn't need two
// render paths. `line` is pre-formatted per source: the backend already
// phrases a broadcast's `summary` as "<code> moved to <TO_STATUS>"; a
// historical row gets the equivalent phrasing built here with a
// human-readable label instead of the raw enum key.
interface FeedItem {
  id: string;
  line: string;
  actorName: string | null;
  note: string | null;
  at: string;
}

function statusLabel(status: UnitStatusKey): string {
  return UNIT_STATUS_LABELS[status] ?? status;
}

function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours === 0) return `${mins}m`;
  return `${hours}h ${mins}m`;
}

// A KPI card for a real, computed count — spec §8.2's "Occupied / Ready /
// Dirty / Out-of-order counts," the one quarter of the strip that has
// data today.
function KpiCard({ label, value, accentClass }: { label: string; value: number; accentClass: string }) {
  return (
    <div className={`rounded border p-3 ${accentClass}`}>
      <p className="text-2xl font-semibold">{value}</p>
      <p className="text-xs font-medium">{label}</p>
    </div>
  );
}

// A stub KPI card for the three-quarters of spec §8.2's strip that depend
// on modules that don't exist yet (bookings/M4, work orders/M3,
// payments/M4, F&B/M5). Deliberately styled to look like a placeholder —
// dashed border, muted text, an explicit "coming in" note — so it can
// never be mistaken for a real zero.
function StubKpiCard({ label, comingIn }: { label: string; comingIn: string }) {
  return (
    <div className="rounded border border-dashed border-gray-300 bg-gray-50 p-3 text-gray-400">
      <p className="text-2xl font-semibold">—</p>
      <p className="text-xs font-medium">{label}</p>
      <p className="text-[10px] italic">Coming in {comingIn}</p>
    </div>
  );
}

// A stub attention-queue row, same "coming in M#" treatment as the KPI
// stub cards above, for the three §8.2 items that depend on work orders
// (M3) or amenities (M5).
function StubAttentionRow({ label, comingIn }: { label: string; comingIn: string }) {
  return (
    <li className="flex items-center justify-between rounded border border-dashed border-gray-300 bg-gray-50 px-3 py-2 text-gray-400">
      <span className="text-sm">{label}</span>
      <span className="text-[10px] italic">Coming in {comingIn}</span>
    </li>
  );
}

export function CommandCenter() {
  const [dashboard, setDashboard] = useState<DashboardData | 'loading' | 'error'>('loading');
  const [feed, setFeed] = useState<FeedItem[] | 'loading' | 'error'>('loading');

  const fetchDashboard = useCallback(() => {
    return api
      .get<DashboardData>('/units/dashboard')
      .then(setDashboard)
      .catch(() => setDashboard('error'));
  }, []);

  useEffect(() => {
    void fetchDashboard();
    api
      .get<{ events: RawActivityEvent[] }>(`/units/activity?limit=${FEED_LIMIT}`)
      .then((res) =>
        setFeed(
          res.events.map((event) => ({
            id: event.id,
            line: `${event.unitCode} — ${event.unitName}: ${statusLabel(event.fromStatus)} → ${statusLabel(event.toStatus)}`,
            actorName: event.actorName,
            note: event.note,
            at: event.createdAt,
          })),
        ),
      )
      .catch(() => setFeed('error'));
  }, [fetchDashboard]);

  // Same fallback principle as UnitsPage's 60s poll (spec §3's "a dropped
  // socket must never leave a stale board with no recovery path") — the
  // KPI strip and attention queue re-fetch even if the realtime channel
  // never delivers a single event.
  useEffect(() => {
    const interval = setInterval(() => void fetchDashboard(), 60_000);
    return () => clearInterval(interval);
  }, [fetchDashboard]);

  // Live activity feed: reuses the exact same `unit.status.changed`
  // broadcast channel the unit grid (task 14) already subscribes to — no
  // second realtime channel. A live update also refreshes the KPI/
  // attention-queue numbers, since a status change can move a unit in or
  // out of "dirty" or "out of order."
  useEffect(() => {
    const unsubscribe = subscribeToUnitStatusChanges((payload) => {
      setFeed((prev) => {
        const next: FeedItem = {
          id: `${payload.entityId}-${payload.version}`,
          line: payload.summary,
          actorName: null,
          note: payload.note,
          at: payload.at,
        };
        const base = Array.isArray(prev) ? prev : [];
        return [next, ...base].slice(0, MAX_FEED_ITEMS);
      });
      void fetchDashboard();
    }, () => {});
    return unsubscribe;
  }, [fetchDashboard]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-lg font-semibold">Command Center</h1>
        <p className="text-sm text-gray-500">
          Occupied/ready/dirty/out-of-order are live from real unit data. Everything marked
          "coming in" below depends on a module not built yet.
        </p>
      </div>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-gray-700">Property status</h2>
        {dashboard === 'loading' && <p className="text-sm text-gray-500">Loading…</p>}
        {dashboard === 'error' && <p role="alert">Could not load the KPI strip.</p>}
        {typeof dashboard === 'object' && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <KpiCard label="Occupied" value={dashboard.kpi.occupied} accentClass="border-purple-300 bg-purple-50 text-purple-900" />
            <KpiCard label="Ready" value={dashboard.kpi.ready} accentClass="border-green-300 bg-green-50 text-green-900" />
            <KpiCard label="Dirty" value={dashboard.kpi.dirty} accentClass="border-amber-300 bg-amber-50 text-amber-900" />
            <KpiCard label="Out of order" value={dashboard.kpi.outOfOrder} accentClass="border-red-300 bg-red-50 text-red-900" />
            <StubKpiCard label="Arrivals / departures today" comingIn="M4" />
            <StubKpiCard label="Open urgent work orders" comingIn="M3" />
            <StubKpiCard label="Pending payment verifications" comingIn="M4" />
            <StubKpiCard label="Open F&B tickets" comingIn="M5" />
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-gray-700">Attention queue</h2>
        <ul className="flex flex-col gap-2">
          {typeof dashboard === 'object' &&
            dashboard.dirtyRooms.map((room) => (
              <li
                key={room.id}
                className="flex items-center justify-between rounded border border-amber-300 bg-amber-50 px-3 py-2"
              >
                <span className="text-sm font-medium text-amber-900">
                  {room.code} — {room.name} still dirty
                </span>
                <span className="text-xs font-semibold text-amber-800">{formatDuration(room.dirtyMinutes)}</span>
              </li>
            ))}
          {typeof dashboard === 'object' && dashboard.dirtyRooms.length === 0 && (
            <li className="text-sm text-gray-500">No rooms dirty past the 3-hour threshold.</li>
          )}
          <StubAttentionRow label="SLA-breached work orders" comingIn="M3" />
          <StubAttentionRow label="Overdue amenities" comingIn="M5" />
          <StubAttentionRow label="Unverified payments >24h" comingIn="M4" />
        </ul>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-gray-700">Live activity</h2>
        {feed === 'loading' && <p className="text-sm text-gray-500">Loading…</p>}
        {feed === 'error' && <p role="alert">Could not load recent activity.</p>}
        {Array.isArray(feed) && feed.length === 0 && (
          <p className="text-sm text-gray-500">No status changes recorded yet.</p>
        )}
        {Array.isArray(feed) && feed.length > 0 && (
          <ul className="flex flex-col gap-2">
            {feed.map((event) => (
              <li key={event.id} className="border-l-2 border-gray-200 pl-3 text-sm">
                <p>{event.line}</p>
                <p className="text-xs text-gray-500">
                  {event.actorName ? `${event.actorName} · ` : ''}
                  {new Date(event.at).toLocaleString()}
                </p>
                {event.note && <p className="text-xs text-gray-600">"{event.note}"</p>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export function DashboardPage() {
  const { user } = useAuth();

  // Everything above needs unit:read (the KPI strip and attention queue
  // both read live Unit/UnitStatusEvent data) — a role without it (e.g.
  // Restaurant Staff, per spec §5.4) gets a plain landing page instead of
  // a Command Center full of permission errors.
  if (!user?.permissions['unit:read']) {
    return (
      <div className="flex flex-col gap-2">
        <h1 className="text-lg font-semibold">Welcome, {user?.fullName}</h1>
        <p className="text-sm text-gray-600">Roles: {user?.roles.join(', ')}</p>
        <p className="text-sm text-gray-500">
          The Command Center is not part of this role's dashboard yet — see spec §8.3.
        </p>
      </div>
    );
  }

  return <CommandCenter />;
}
