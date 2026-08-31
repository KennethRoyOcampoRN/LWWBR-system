import type { AnyUnitStatusKey } from '@lwwbr/shared';
import { useCallback, useEffect, useState, type ReactNode, type SVGProps } from 'react';
import { Link } from 'react-router-dom';
import { EmptyState } from '../components/EmptyState.js';
import { ErrorBoundary, WidgetError } from '../components/ErrorBoundary.js';
import {
  IconActivity,
  IconAlertTriangle,
  IconArrowIn,
  IconArrowOut,
  IconBed,
  IconBroom,
  IconCheck,
  IconUtensils,
} from '../components/icons.js';
import { SkeletonCard, SkeletonList } from '../components/Skeleton.js';
import { useAuth } from '../context/AuthContext.js';
import { api } from '../lib/api.js';
import { loadDashboardSnapshot, saveDashboardSnapshot } from '../lib/dashboardCache.js';
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

// Spec §11 M6 visual redesign (2026-08-31): 'hero-brand'/'hero-danger'
// are the two gradient-filled accent cards for the property's headline
// numbers (Occupied — the neutral "how full are we" metric — and Open
// urgent work orders — the "needs attention now" metric). Deliberately
// two different gradients, not one: flattening both into the same brand
// violet would lose the good/neutral-vs-needs-attention distinction the
// old color-coded cards had. Every other KPI is a soft-tinted card using
// one of the semantic colors below, matched to what the number actually
// means (success = good state, warning = needs eventual attention,
// danger = needs attention now, info = neutral count, accent = a
// distinct department color so it doesn't collide with info).
type KpiVariant =
  'hero-brand' | 'hero-danger' | 'success' | 'warning' | 'danger' | 'info' | 'accent';

const KPI_VARIANT_CLASSES: Record<
  KpiVariant,
  { card: string; iconBadge: string; value: string; label: string }
> = {
  'hero-brand': {
    card: 'bg-brand-gradient',
    iconBadge: 'bg-white/20 text-white',
    value: 'text-white',
    label: 'text-white/80',
  },
  'hero-danger': {
    card: 'bg-danger-gradient',
    iconBadge: 'bg-white/20 text-white',
    value: 'text-white',
    label: 'text-white/80',
  },
  success: {
    card: 'bg-white',
    iconBadge: 'bg-success-50 text-success-600',
    value: 'text-ink',
    label: 'text-ink-secondary',
  },
  warning: {
    card: 'bg-white',
    iconBadge: 'bg-warning-50 text-warning-600',
    value: 'text-ink',
    label: 'text-ink-secondary',
  },
  danger: {
    card: 'bg-white',
    iconBadge: 'bg-danger-50 text-danger-600',
    value: 'text-ink',
    label: 'text-ink-secondary',
  },
  info: {
    card: 'bg-white',
    iconBadge: 'bg-info-50 text-info-600',
    value: 'text-ink',
    label: 'text-ink-secondary',
  },
  accent: {
    card: 'bg-white',
    iconBadge: 'bg-accent-50 text-accent-600',
    value: 'text-ink',
    label: 'text-ink-secondary',
  },
};

// A KPI card for a real, computed count — spec §8.2's "Occupied / Ready /
// Dirty / Out-of-order counts," the one quarter of the strip that has
// data today. `icon` takes the component itself (not a pre-rendered
// element) so this is the one place that sizes it — every one of these
// hand-rolled SVGs (icons.tsx) has no intrinsic width/height of its own,
// so an icon rendered without an explicit size class falls back to the
// browser's default SVG box (huge) and blows out the card layout.
//
// `to`, when given, makes the whole card a real `Link` (a genuine <a>,
// keyboard-focusable) rather than a div with an onClick — only two KPIs
// use this today (Open urgent work orders → /work-orders, Open F&B
// tickets → /restaurant, both wired in CommandCenter below); the rest
// stay plain, non-interactive cards.
function KpiCard({
  label,
  value,
  variant,
  icon: Icon,
  to,
}: {
  label: string;
  value: number;
  variant: KpiVariant;
  icon: (props: SVGProps<SVGSVGElement>) => ReactNode;
  to?: string;
}) {
  const classes = KPI_VARIANT_CLASSES[variant];
  const content = (
    <>
      <span
        className={`flex h-10 w-10 items-center justify-center rounded-full ${classes.iconBadge}`}
      >
        <Icon className="h-5 w-5" />
      </span>
      <div>
        <p className={`text-2xl font-semibold ${classes.value}`}>{value}</p>
        <p className={`text-xs font-medium ${classes.label}`}>{label}</p>
      </div>
    </>
  );
  const className = `flex flex-col gap-3 rounded-2xl p-4 shadow-card transition-shadow ${classes.card}`;
  if (to) {
    return (
      <Link
        to={to}
        className={`${className} hover:shadow-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600`}
      >
        {content}
      </Link>
    );
  }
  return <div className={className}>{content}</div>;
}

export function CommandCenter() {
  const { user } = useAuth();
  // The F&B KPI card only links to /restaurant when the viewer actually
  // holds fnb:read — Command Center is visible to every unit:read
  // holder, which includes roles (e.g. POC Housekeeping/Maintenance)
  // that don't hold fnb:read. RequirePermission would show a graceful
  // "no permission" message rather than crash, but there's no reason to
  // offer a clickable card that's certain to dead-end — same standard
  // already applied elsewhere in this app (e.g. FnbPage only offering
  // Delete once it's guaranteed not to be refused). Open urgent work
  // orders has no equivalent check: workorder:read is the one
  // permission every role holds.
  const canViewFnb = Boolean(user?.permissions['fnb:read']);
  const [dashboard, setDashboard] = useState<DashboardData | 'loading' | 'error'>('loading');
  const [feed, setFeed] = useState<FeedItem[] | 'loading' | 'error'>('loading');
  // Spec §3 / §11 M6: "cache the last-known board read-only so a staff
  // member with no signal still sees their task list." `cachedAt` is
  // non-null exactly when what's on screen came from that cache rather
  // than a live fetch — that's what the banner below keys off, and it
  // clears the moment a live fetch succeeds again.
  const [cachedAt, setCachedAt] = useState<string | null>(null);

  const fetchDashboard = useCallback(() => {
    return api
      .get<DashboardData>('/units/dashboard')
      .then((data) => {
        setDashboard(data);
        setCachedAt(null);
        saveDashboardSnapshot<DashboardData, FeedItem[]>({ dashboard: data });
      })
      .catch(() => {
        const snapshot = loadDashboardSnapshot<DashboardData, FeedItem[]>();
        if (snapshot?.dashboard) {
          setDashboard(snapshot.dashboard);
          setCachedAt(snapshot.cachedAt);
        } else {
          setDashboard('error');
        }
      });
  }, []);

  useEffect(() => {
    void fetchDashboard();
    api
      .get<{ events: RawActivityEvent[] }>(`/units/activity?limit=${FEED_LIMIT}`)
      .then((res) => {
        const items = res.events.map((event) => ({
          id: event.id,
          line: `${event.unitCode} — ${event.unitName}: ${statusLabel(event.fromStatus)} → ${statusLabel(event.toStatus)}`,
          actorName: event.actorName,
          note: event.note,
          at: event.createdAt,
        }));
        setFeed(items);
        saveDashboardSnapshot<DashboardData, FeedItem[]>({ feed: items });
      })
      .catch(() => {
        const snapshot = loadDashboardSnapshot<DashboardData, FeedItem[]>();
        if (snapshot?.feed) {
          setFeed(snapshot.feed);
          setCachedAt((prev) => prev ?? snapshot.cachedAt);
        } else {
          setFeed('error');
        }
      });
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
    const unsubscribe = subscribeToUnitStatusChanges(
      (payload) => {
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
      },
      () => {},
    );
    return unsubscribe;
  }, [fetchDashboard]);

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-xl font-semibold leading-tight text-ink">Command Center</h1>
        <p className="text-sm leading-relaxed text-ink-secondary">
          Every card here is live from real data.
        </p>
      </div>

      {cachedAt && (
        <div
          role="status"
          className="rounded-2xl bg-warning-50 p-4 text-sm leading-relaxed text-warning-600 shadow-card"
        >
          Offline — showing the last known board as of {new Date(cachedAt).toLocaleString()}.
          Read-only; nothing below can be actioned until the connection returns.
        </div>
      )}

      {/* Spec §11 M6: three genuinely simultaneous, independent widgets
          on one screen — the strongest case in this app for per-widget
          error isolation, so a crash in one (e.g. a malformed feed
          timestamp) doesn't take the other two down with it. */}
      <ErrorBoundary
        fallback={(_error, reset) => <WidgetError label="Property status" reset={reset} />}
      >
        <section>
          <h2 className="mb-3 text-sm font-semibold text-ink-secondary">Property status</h2>
          {dashboard === 'loading' && (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              {Array.from({ length: 8 }, (_, i) => (
                <SkeletonCard key={i} />
              ))}
            </div>
          )}
          {dashboard === 'error' && <p role="alert">Could not load the KPI strip.</p>}
          {typeof dashboard === 'object' && (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <KpiCard
                label="Occupied"
                value={dashboard.kpi.occupied}
                variant="hero-brand"
                icon={IconBed}
              />
              <KpiCard
                label="Ready"
                value={dashboard.kpi.ready}
                variant="success"
                icon={IconCheck}
              />
              <KpiCard
                label="Dirty"
                value={dashboard.kpi.dirty}
                variant="warning"
                icon={IconBroom}
              />
              <KpiCard
                label="Out of order"
                value={dashboard.kpi.outOfOrder}
                variant="danger"
                icon={IconAlertTriangle}
              />
              <KpiCard
                label="Open urgent work orders"
                value={dashboard.kpi.urgentOpenWorkOrders}
                variant="hero-danger"
                icon={IconAlertTriangle}
                to="/work-orders"
              />
              <KpiCard
                label="Check-ins today"
                value={dashboard.kpi.checkinsToday}
                variant="info"
                icon={IconArrowIn}
              />
              <KpiCard
                label="Check-outs today"
                value={dashboard.kpi.checkoutsToday}
                variant="info"
                icon={IconArrowOut}
              />
              <KpiCard
                label="Open F&B tickets"
                value={dashboard.kpi.openFnbOrders}
                variant="accent"
                icon={IconUtensils}
                to={canViewFnb ? '/restaurant' : undefined}
              />
            </div>
          )}
        </section>
      </ErrorBoundary>

      {/* Client feedback, 2026-08-31: these two widgets stacked one after
          another burned too much vertical space, especially with a full
          Attention queue. Side-by-side from md up (the same breakpoint
          the nav already switches on); back to stacked below that, where
          two columns wouldn't fit meaningfully. */}
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <ErrorBoundary
          fallback={(_error, reset) => <WidgetError label="Attention queue" reset={reset} />}
        >
          <section className="rounded-2xl bg-white p-4 shadow-card">
            <h2 className="mb-3 text-sm font-semibold text-ink-secondary">Attention queue</h2>
            {dashboard === 'loading' && <SkeletonList />}
            {typeof dashboard === 'object' && (
              <ul className="flex flex-col gap-2">
                {dashboard.dirtyRooms.map((room) => (
                  <li
                    key={room.id}
                    className="flex items-center justify-between rounded-xl bg-warning-50 px-4 py-3"
                  >
                    <span className="flex items-center gap-3 text-sm font-medium text-ink">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white text-warning-600">
                        <IconBroom className="h-4 w-4" />
                      </span>
                      {room.code} — {room.name} still dirty
                    </span>
                    <span className="text-xs font-semibold text-warning-600">
                      {formatDuration(room.dirtyMinutes)}
                    </span>
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
                    className="flex items-center justify-between rounded-xl bg-danger-50 px-4 py-3"
                  >
                    <span className="flex items-center gap-3 text-sm font-medium text-ink">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white text-danger-600">
                        <IconAlertTriangle className="h-4 w-4" />
                      </span>
                      {wo.referenceNo} — {wo.title}
                      {wo.unitCode ? ` (${wo.unitCode})` : ''} past due
                    </span>
                    <span className="text-xs font-semibold text-danger-600">
                      {formatDuration(wo.overdueMinutes)}
                    </span>
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
                    className="flex items-center justify-between rounded-xl bg-accent-50 px-4 py-3"
                  >
                    <span className="flex items-center gap-3 text-sm font-medium text-ink">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white text-accent-600">
                        <IconAlertTriangle className="h-4 w-4" />
                      </span>
                      {req.referenceNo} — {req.itemName}
                      {req.unitCode ? ` (${req.unitCode})` : ''} overdue
                    </span>
                    <span className="text-xs font-semibold text-accent-600">
                      {formatDuration(req.overdueMinutes)}
                    </span>
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

        <ErrorBoundary
          fallback={(_error, reset) => <WidgetError label="Live activity" reset={reset} />}
        >
          <section className="rounded-2xl bg-white p-4 shadow-card">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-ink-secondary">
              <IconActivity className="h-4 w-4 text-brand-600" />
              Live activity
            </h2>
            {feed === 'loading' && <SkeletonList />}
            {feed === 'error' && <p role="alert">Could not load recent activity.</p>}
            {Array.isArray(feed) && feed.length === 0 && (
              <EmptyState message="No status changes recorded yet." />
            )}
            {Array.isArray(feed) && feed.length > 0 && (
              <ul className="flex flex-col gap-3">
                {feed.map((event) => (
                  <li
                    key={event.id}
                    className="border-l-2 border-brand-100 pl-3 text-sm leading-relaxed"
                  >
                    <p className="text-ink">{event.line}</p>
                    <p className="text-xs text-ink-muted">
                      {event.actorName ? `${event.actorName} · ` : ''}
                      {new Date(event.at).toLocaleString()}
                    </p>
                    {event.note && <p className="text-xs text-ink-secondary">"{event.note}"</p>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </ErrorBoundary>
      </div>
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
        <h1 className="text-xl font-semibold leading-tight text-ink">Welcome, {user?.fullName}</h1>
        <p className="text-sm leading-relaxed text-ink-secondary">
          Roles: {user?.roles.join(', ')}
        </p>
        <p className="text-sm leading-relaxed text-ink-muted">
          The Command Center is not part of this role's dashboard yet — see spec §8.3.
        </p>
      </div>
    );
  }

  return <CommandCenter />;
}
