// Spec §11 M6 / §3's "known trade-off": "cache the last-known board
// read-only so a staff member with no signal still sees their task
// list." This is the data half of that — DashboardPage saves a snapshot
// here after every successful load, and reads it back if a live fetch
// fails. The app-shell half (letting the SPA itself boot offline) is
// public/sw.js; the two are independent by design, see that file's own
// comment for why /api/* is deliberately excluded from its cache.
//
// localStorage, not IndexedDB: this is one small JSON blob (KPI counts,
// two short lists), not the binary photo-queue spec describes elsewhere
// for §8.3 — no reason to reach for IndexedDB's async API over a
// synchronous read/write for something this size. Every access is
// wrapped in try/catch — localStorage can throw (private browsing, quota
// exceeded, disabled entirely), and a cache that fails must never crash
// the page it exists to keep viewable.
const STORAGE_KEY = 'lwwbr.dashboardSnapshot.v1';

export interface DashboardSnapshot<TDashboard, TFeed> {
  dashboard?: TDashboard;
  feed?: TFeed;
  cachedAt: string;
}

// The KPI strip/attention queue and the live-activity feed load on
// separate requests and can each succeed or fail independently — this
// merges into whatever was cached before rather than overwriting the
// other half, so (for example) a feed load failing right after a
// successful dashboard load doesn't blow away the dashboard half that
// just saved a moment ago.
export function saveDashboardSnapshot<TDashboard, TFeed>(
  partial: Partial<Pick<DashboardSnapshot<TDashboard, TFeed>, 'dashboard' | 'feed'>>,
): void {
  try {
    const existing = loadDashboardSnapshot<TDashboard, TFeed>() ?? {};
    const snapshot: DashboardSnapshot<TDashboard, TFeed> = {
      ...existing,
      ...partial,
      cachedAt: new Date().toISOString(),
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // Best-effort only — a failed save just means the next offline load
    // falls back to whatever (if anything) was saved before, or to the
    // ordinary error state. Never let this throw into the caller.
  }
}

export function loadDashboardSnapshot<TDashboard, TFeed>(): DashboardSnapshot<TDashboard, TFeed> | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as DashboardSnapshot<TDashboard, TFeed>;
  } catch {
    return null;
  }
}
