import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SupabaseStorageAdapter } from '../../src/adapters/storage/supabaseStorageAdapter.js';

// UNVERIFIED IN THIS SESSION — see /README.md "M0 status". This test needs
// a running local Supabase stack (`supabase start`), which requires Docker
// and was not available in the environment this was written in. It has
// never been executed. Run it after `supabase start` to confirm the
// StorageAdapter round-trips against real Supabase Storage.
//
// `supabase start` prints SUPABASE_URL as "API URL" and
// SUPABASE_SERVICE_ROLE_KEY as "service_role key" — put both in
// apps/api/.env before running.
const hasLocalSupabase = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);

describe.skipIf(!hasLocalSupabase)('SupabaseStorageAdapter round-trip', () => {
  const bucket = process.env.SUPABASE_STORAGE_BUCKET ?? 'lwwbr-files';
  // Fallback values only exist so construction doesn't throw during test
  // *collection* (Vitest evaluates describe bodies even when skipped).
  // Real values are required for the tests themselves to run — see
  // hasLocalSupabase above.
  const supabaseUrl = process.env.SUPABASE_URL ?? 'http://localhost:54321';
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? 'unset';
  const adapter = new SupabaseStorageAdapter(supabaseUrl, serviceRoleKey, bucket);
  const key = `test/m0-roundtrip-${Date.now()}.txt`;
  const contents = Buffer.from('lwwbr storage round-trip check');

  beforeAll(async () => {
    const admin = createClient(supabaseUrl, serviceRoleKey);
    const { data: buckets } = await admin.storage.listBuckets();
    if (!buckets?.some((b) => b.name === bucket)) {
      await admin.storage.createBucket(bucket, { public: false });
    }
  });

  afterAll(async () => {
    await adapter.delete(key).catch(() => undefined);
  });

  it('uploads and downloads the same bytes', async () => {
    const uploaded = await adapter.upload({ key, buffer: contents, contentType: 'text/plain' });
    expect(uploaded.key).toBe(key);

    const downloaded = await adapter.download(key);
    expect(downloaded.equals(contents)).toBe(true);
  });

  it('issues a signed URL that is never a public bucket URL', async () => {
    const url = await adapter.getSignedUrl(key, 60);
    expect(url).toContain('token=');
  });
});
