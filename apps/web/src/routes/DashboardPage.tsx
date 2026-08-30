import type { AnyUnitStatusKey } from '@lwwbr/shared';
import { useCallback, useEffect, useState } from 'react';
import { EmptyState } from '../components/EmptyState.js';
import { ErrorBoundary, WidgetError } from '../components/ErrorBoundary.js';
import { SkeletonCard, SkeletonList } from '../components/Skeleton.js';
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
  kpi: {
    occupied: number;
    ready: number;
    dirty: number;
    outOfOrder: number;
    urgentOpenWorkOrders: number;
    checkinsToday: number;
    checkoutsToday: number;
    openFnbOrders: number;
  };
  dirtyRooms: { id: string; code: string; name: string; dirtyMinutes: number }[];
  slaBreachedWorkOrders: {
    id: string;
    referenceNo: string;
    title: string;
    unitCode: string | null;
    overdueMinutes: number;
  }[];
  overdueAmenityRequests: {
    id: string;
    referenceNo: string;
    itemName: string;
    unitCode: string | null;
    overdueMinutes: number;
  }[];
}

interface RawActivityEvent {
  id: string;
  unitCode: string;
  unitName: string;
  // AnyUnitStatusKey, not the forward-only UnitStatusKey: this feed
  // reads every historical UnitStatusEvent row, and a genuinely old one
  // can reference the retired INSPECTED status (retired 2026-08-22) —
  // that's a true historical fact, not something this feed should hide
  // or crash on.
  fromStatus: AnyUnitStatusKey;
  toStatus: AnyUnitStatusKey;
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

function statusLabel(status: AnyUnitStatusKey): string {
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
        <p className="text-sm text-gray-500">Every card here is live from real data.</p>
      </div>

      {/* Spec §11 M6: three genuinely simultaneous, independent widgets
          on one screen — the strongest case in this app for per-widget
          error isolation, so a crash in one (e.g. a malformed feed
          timestamp) doesn't take the other two down with it. */}
      <ErrorBoundary fallback={(_error, reset) => <WidgetError label="Property status" reset={reset} />}>
        <section>
          <h2 className="mb-2 text-sm font-semibold text-gray-700">Property status</h2>
          {dashboard === 'loading' && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {Array.from({ length: 8 }, (_, i) => (
                <SkeletonCard key={i} />
              ))}
            </div>
          )}
          {dashboard === 'error' && <p role="alert">Could not load the KPI strip.</p>}
          {typeof dashboard === 'object' && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <KpiCard label="Occupied" value={dashboard.kpi.occupied} accentClass="border-purple-300 bg-purple-50 text-purple-900" />
              <KpiCard label="Ready" value={dashboard.kpi.ready} accentClass="border-green-300 bg-green-50 text-green-900" />
              <KpiCard label="Dirty" value={dashboard.kpi.dirty} accentClass="border-amber-300 bg-amber-50 text-amber-900" />
              <KpiCard label="Out of order" value={dashboard.kpi.outOfOrder} accentClass="border-red-300 bg-red-50 text-red-900" />
              <KpiCard
                label="Open urgent work orders"
                value={dashboard.kpi.urgentOpenWorkOrders}
                accentClass="border-red-300 bg-red-50 text-red-900"
              />
              <KpiCard
                label="Check-ins today"
                value={dashboard.kpi.checkinsToday}
                accentClass="border-blue-300 bg-blue-50 text-blue-900"
              />
              <KpiCard
                label="Check-outs today"
                value={dashboard.kpi.checkoutsToday}
                accentClass="border-blue-300 bg-blue-50 text-blue-900"
              />
              <KpiCard
                label="Open F&B tickets"
                value={dashboard.kpi.openFnbOrders}
                accentClass="border-orange-300 bg-orange-50 text-orange-900"
              />
            </div>
          )}
        </section>
      </ErrorBoundary>

      <ErrorBoundary fallback={(_error, reset) => <WidgetError label="Attention queue" reset={reset} />}>
        <section>
          <h2 className="mb-2 text-sm font-semibold text-gray-700">Attention queue</h2>
          {dashboard === 'loading' && <SkeletonList />}
          {typeof dashboard === 'object' && (
            <ul className="flex flex-col gap-2">
              {dashboard.dirtyRooms.map((room) => (
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
              {dashboard.dirtyRooms.length === 0 && (
                <li>
                  <EmptyState message="No rooms dirty past the 3-hour threshold." />
                </li>
              )}
              {dashboard.slaBreachedWorkOrders.map((wo) => (
                <li
                  key={wo.id}
                  className="flex items-center justify-between rounded border border-red-300 bg-red-50 px-3 py-2"
                >
                  <span className="text-sm font-medium text-red-900">
                    {wo.referenceNo} — {wo.title}
                    {wo.unitCode ? ` (${wo.unitCode})` : ''} past due
                  </span>
                  <span className="text-xs font-semibold text-red-800">{formatDuration(wo.overdueMinutes)}</span>
                </li>
              ))}
              {dashboard.slaBreachedWorkOrders.length === 0 && (
                <li>
                  <EmptyState message="No work orders past their SLA due date." />
                </li>
              )}
              {dashboard.overdueAmenityRequests.map((req) => (
                <li
                  key={req.id}
                  className="flex items-center justify-between rounded border border-orange-300 bg-orange-50 px-3 py-2"
                >
                  <span className="text-sm font-medium text-orange-900">
                    {req.referenceNo} — {req.itemName}
                    {req.unitCode ? ` (${req.unitCode})` : ''} overdue
                  </span>
                  <span className="text-xs font-semibold text-orange-800">{formatDuration(req.overdueMinutes)}</span>
                </li>
              ))}
              {dashboard.overdueAmenityRequests.length === 0 && (
                <li>
                  <EmptyState message="No amenity requests past their due-back time." />
                </li>
              )}
            </ul>
          )}
        </section>
      </ErrorBoundary>

      <ErrorBoundary fallback={(_error, reset) => <WidgetError label="Live activity" reset={reset} />}>
        <section>
          <h2 className="mb-2 text-sm font-semibold text-gray-700">Live activity</h2>
          {feed === 'loading' && <SkeletonList />}
          {feed === 'error' && <p role="alert">Could not load recent activity.</p>}
          {Array.isArray(feed) && feed.length === 0 && <EmptyState message="No status changes recorded yet." />}
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
      </ErrorBoundary>
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
