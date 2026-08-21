import { getEnv } from '../../lib/env.js';
import { SupabaseRealtimeAdapter } from './supabaseRealtimeAdapter.js';
import type { RealtimeAdapter } from './types.js';

export type { RealtimeAdapter, RealtimeChannel, RealtimeEventPayload } from './types.js';

let cachedAdapter: RealtimeAdapter | undefined;

/**
 * Resolves the realtime adapter. MVP ships the Supabase implementation
 * only (spec §3.1) — the interface stays swappable, but there is no
 * self-hosted alternative to resolve to yet.
 */
export function getRealtimeAdapter(): RealtimeAdapter {
  if (!cachedAdapter) {
    const env = getEnv();
    cachedAdapter = new SupabaseRealtimeAdapter(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  }
  return cachedAdapter;
}

export function resolvedRealtimeAdapterName(): 'supabase' {
  return 'supabase';
}
