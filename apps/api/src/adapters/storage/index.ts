import { getEnv } from '../../lib/env.js';
import { SupabaseStorageAdapter } from './supabaseStorageAdapter.js';
import type { StorageAdapter } from './types.js';

export type { StorageAdapter, StoredFile } from './types.js';

let cachedAdapter: StorageAdapter | undefined;

/**
 * Resolves the storage adapter. MVP ships the Supabase implementation
 * only (spec §3.1) — the interface stays swappable, but there is no
 * self-hosted alternative to resolve to yet.
 */
export function getStorageAdapter(): StorageAdapter {
  if (!cachedAdapter) {
    const env = getEnv();
    cachedAdapter = new SupabaseStorageAdapter(
      env.SUPABASE_URL,
      env.SUPABASE_SERVICE_ROLE_KEY,
      env.SUPABASE_STORAGE_BUCKET,
    );
  }
  return cachedAdapter;
}

export function resolvedStorageAdapterName(): 'supabase' {
  return 'supabase';
}
