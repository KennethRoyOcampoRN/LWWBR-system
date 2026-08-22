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
  cachedClient = createClient(url, anonKey);
  return cachedClient;
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
