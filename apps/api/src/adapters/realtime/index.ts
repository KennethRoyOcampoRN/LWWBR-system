import type { Server } from 'socket.io';
import { getEnv } from '../../lib/env.js';
import { SocketIoRealtimeAdapter } from './socketIoRealtimeAdapter.js';
import { SupabaseRealtimeAdapter } from './supabaseRealtimeAdapter.js';
import type { RealtimeAdapter } from './types.js';

export type { RealtimeAdapter, RealtimeChannel, RealtimeEventPayload } from './types.js';

let cachedAdapter: RealtimeAdapter | undefined;
let registeredSocketIoServer: Server | undefined;

// Called once at boot by the self-hosted entrypoint (src/index.ts) after
// attachSocketIoServer() creates the io instance — unlike the storage
// adapter, Socket.IO needs an http.Server to attach to, which createApp()
// deliberately doesn't own (it's shared with the Netlify function wrapper
// path too), so this is how the instance reaches getRealtimeAdapter().
export function registerSocketIoServer(io: Server): void {
  registeredSocketIoServer = io;
  cachedAdapter = undefined;
}

/**
 * Resolves the realtime adapter per REALTIME_ADAPTER (spec.md §13
 * decision 11) — 'supabase' (default, unaffected cloud behavior) or
 * 'socketio' (the mini PC deployment).
 */
export function getRealtimeAdapter(): RealtimeAdapter {
  if (!cachedAdapter) {
    const env = getEnv();
    if (env.REALTIME_ADAPTER === 'socketio') {
      if (!registeredSocketIoServer) {
        throw new Error('REALTIME_ADAPTER=socketio requires registerSocketIoServer() to run before the first emit.');
      }
      cachedAdapter = new SocketIoRealtimeAdapter(registeredSocketIoServer);
    } else {
      if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
        throw new Error('REALTIME_ADAPTER=supabase requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to be set.');
      }
      cachedAdapter = new SupabaseRealtimeAdapter(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
    }
  }
  return cachedAdapter;
}

export function resolvedRealtimeAdapterName(): 'supabase' | 'socketio' {
  return getEnv().REALTIME_ADAPTER;
}
