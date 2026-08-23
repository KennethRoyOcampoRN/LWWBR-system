import { createClient, type RealtimeChannel } from '@supabase/supabase-js';

// Spec §9.1 / §3: MVP realtime transport is Supabase Realtime broadcast
// only (no Socket.IO implementation is built) — channel `property`,
// event `unit.status.changed`, payload `{ entityId, actorId, at, summary, ... }`.
// This mirrors apps/api's SupabaseRealtimeAdapter.emit() exactly: the
// backend broadcasts on the `property` channel after every unit status
// write (normal, override, or forced correction), and this is the
// browser-side subscriber. Uses the public anon key — never the service
// role key, which must never reach the browser bundle.
export interface UnitStatusChangedPayload {
  entityId: string;
  actorId: string;
  at: string;
  summary: string;
  fromStatus: string;
  toStatus: string;
  version: number;
  note: string | null;
}

// Connection health for the drawer/grid's "reconnecting" indicator (spec
// §3's resiliency rule: "a dropped socket must never leave a stale board
// with no recovery path"). 'disabled' means no Supabase env vars were
// configured — realtime is simply off, not broken; the 60s poll fallback
// in UnitsPage still keeps the grid current either way.
export type RealtimeConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'disabled';

let cachedClient: ReturnType<typeof createClient> | undefined | null;

function getSupabaseClient() {
  if (cachedClient !== undefined) {
    return cachedClient;
  }
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  if (!url || !anonKey) {
    console.warn(
      'VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are not set — realtime status updates are disabled; the grid still refreshes via its 60s poll fallback.',
    );
    cachedClient = null;
    return cachedClient;
  }
  try {
    // Real bug, found live 2026-08-22: .env.example's placeholder
    // (`https://<project-ref>.supabase.co`) left in .env untouched
    // crashed createClient() with an uncaught "Invalid supabaseUrl" —
    // thrown synchronously from inside a React effect, with no error
    // boundary in this app, so it took down the whole Units page to a
    // blank screen with no visible message. A malformed value (leftover
    // placeholder, typo) must degrade to 'disabled' the same way a
    // missing one does, not crash the tree.
    cachedClient = createClient(url, anonKey);
  } catch (error) {
    console.error(
      `VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are set but invalid (still a placeholder from .env.example, or a typo?) — realtime status updates are disabled; the grid still refreshes via its 60s poll fallback. Underlying error: ${error instanceof Error ? error.message : String(error)}`,
    );
    cachedClient = null;
  }
  return cachedClient;
}

// Spec §9.1: `notification.new` — emitted on either a `user:{id}` channel
// (a notification targeted at one person, e.g. a work order assigned to
// them) or a `dept:{department}` channel (e.g. an urgent work order,
// §7.2 — everyone in the target department). This is the browser-side
// payload shape apps/api's notifications module emits on both.
export interface NotificationPayload {
  entityId: string;
  actorId: string;
  at: string;
  summary: string;
  type: string;
  title: string;
  body: string;
  relatedEntityType: string | null;
  relatedEntityId: string | null;
}

/**
 * Subscribes to the `property` channel's `unit.status.changed` broadcast.
 * Returns an unsubscribe function safe to call from a React effect
 * cleanup even if the client was never created (env vars unset).
 */
export function subscribeToUnitStatusChanges(
  onEvent: (payload: UnitStatusChangedPayload) => void,
  onStatusChange: (status: RealtimeConnectionStatus) => void,
): () => void {
  const client = getSupabaseClient();
  if (!client) {
    onStatusChange('disabled');
    return () => {};
  }

  let channel: RealtimeChannel | null = client.channel('property');
  onStatusChange('connecting');
  channel.on('broadcast', { event: 'unit.status.changed' }, ({ payload }) => {
    onEvent(payload as UnitStatusChangedPayload);
  });
  channel.subscribe((status) => {
    onStatusChange(status === 'SUBSCRIBED' ? 'connected' : 'reconnecting');
  });

  return () => {
    if (channel) {
      void client.removeChannel(channel);
      channel = null;
    }
  };
}

/**
 * Subscribes to both channels a signed-in user's notifications can arrive
 * on: their own `user:{id}` channel (assigned-to-you, reopened-on-you)
 * and their `dept:{department}` channel (urgent tickets filed for their
 * department, §7.2). Same disabled/connecting/connected/reconnecting
 * status contract as subscribeToUnitStatusChanges — the notification bell
 * degrades to poll-only rather than crashing when realtime is off.
 */
export function subscribeToNotifications(
  userId: string,
  department: string,
  onEvent: (payload: NotificationPayload) => void,
  onStatusChange: (status: RealtimeConnectionStatus) => void,
): () => void {
  const client = getSupabaseClient();
  if (!client) {
    onStatusChange('disabled');
    return () => {};
  }

  let userChannel: RealtimeChannel | null = client.channel(`user:${userId}`);
  let deptChannel: RealtimeChannel | null = client.channel(`dept:${department}`);
  onStatusChange('connecting');

  const handleBroadcast = ({ payload }: { payload: unknown }) => onEvent(payload as NotificationPayload);
  userChannel.on('broadcast', { event: 'notification.new' }, handleBroadcast);
  deptChannel.on('broadcast', { event: 'notification.new' }, handleBroadcast);

  // Both channels report their own subscribe status independently;
  // 'connected' only once both have confirmed, 'reconnecting' the moment
  // either drops.
  const statuses = { user: 'connecting', dept: 'connecting' };
  const reportCombinedStatus = () => {
    if (statuses.user === 'SUBSCRIBED' && statuses.dept === 'SUBSCRIBED') {
      onStatusChange('connected');
    } else {
      onStatusChange('reconnecting');
    }
  };
  userChannel.subscribe((status) => {
    statuses.user = status;
    reportCombinedStatus();
  });
  deptChannel.subscribe((status) => {
    statuses.dept = status;
    reportCombinedStatus();
  });

  return () => {
    if (userChannel) {
      void client.removeChannel(userChannel);
      userChannel = null;
    }
    if (deptChannel) {
      void client.removeChannel(deptChannel);
      deptChannel = null;
    }
  };
}
