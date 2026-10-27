import { getEnv } from '../../lib/env.js';
import { LocalDiskStorageAdapter } from './localDiskStorageAdapter.js';
import { SupabaseStorageAdapter } from './supabaseStorageAdapter.js';
import type { StorageAdapter } from './types.js';

export type { StorageAdapter, StoredFile } from './types.js';
export { LocalDiskStorageAdapter } from './localDiskStorageAdapter.js';

let cachedAdapter: StorageAdapter | undefined;

/**
 * Resolves the storage adapter per STORAGE_ADAPTER (spec.md §13 decision
 * 11) — 'supabase' (default, unaffected cloud behavior) or 'local' (the
 * mini PC deployment).
 */
export function getStorageAdapter(): StorageAdapter {
  if (!cachedAdapter) {
    const env = getEnv();
    if (env.STORAGE_ADAPTER === 'local') {
      if (!env.FILE_SIGNING_SECRET) {
        throw new Error('STORAGE_ADAPTER=local requires FILE_SIGNING_SECRET to be set.');
      }
      cachedAdapter = new LocalDiskStorageAdapter(env.UPLOADS_DIR, env.FILE_SIGNING_SECRET);
    } else {
      if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
        throw new Error('STORAGE_ADAPTER=supabase requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to be set.');
      }
      cachedAdapter = new SupabaseStorageAdapter(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, env.SUPABASE_STORAGE_BUCKET);
    }
  }
  return cachedAdapter;
}

export function resolvedStorageAdapterName(): 'supabase' | 'local' {
  return getEnv().STORAGE_ADAPTER;
}
