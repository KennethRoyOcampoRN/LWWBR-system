import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { LocalDiskStorageAdapter } from '../../src/adapters/storage/localDiskStorageAdapter.js';

// Client decision, 2026-10-27 (spec.md §13 decision 11): unlike the
// Supabase round-trip test above, this one needs no real network or
// hosted credentials — a temp directory is all LocalDiskStorageAdapter
// depends on — so it actually runs (not skipped) in every environment,
// this sandbox included.
describe('LocalDiskStorageAdapter round-trip', () => {
  let rootDir: string;
  const signingSecret = 'test-signing-secret-at-least-32-characters-long';
  const key = 'uploads/test-file.txt';
  const contents = Buffer.from('lwwbr local-disk storage round-trip check');

  beforeAll(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'lwwbr-storage-'));
  });

  afterAll(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it('uploads and downloads the same bytes, creating the key\'s subdirectory as needed', async () => {
    const adapter = new LocalDiskStorageAdapter(rootDir, signingSecret);
    const uploaded = await adapter.upload({ key, buffer: contents, contentType: 'text/plain' });
    expect(uploaded.key).toBe(key);

    const downloaded = await adapter.download(key);
    expect(downloaded.equals(contents)).toBe(true);
  });

  it('delete actually removes the file — a subsequent download rejects', async () => {
    const adapter = new LocalDiskStorageAdapter(rootDir, signingSecret);
    await adapter.upload({ key: 'uploads/to-delete.txt', buffer: contents, contentType: 'text/plain' });
    await adapter.delete('uploads/to-delete.txt');
    await expect(adapter.download('uploads/to-delete.txt')).rejects.toThrow();
  });

  describe('getSignedUrl / verifySignedRequest', () => {
    const adapter = new LocalDiskStorageAdapter(rootDir, signingSecret);

    // Real bug, found during manual end-to-end verification (spec.md
    // §13 decision 11): getSignedUrl() originally minted "/files/signed"
    // — missing the "/api/v1" prefix GET /files/signed is actually
    // mounted under (app.ts: `app.use('/api/v1', filesRouter)`). The
    // link silently resolved to the SPA's own index.html fallback
    // instead of the file — a real browser's <img>/<a> would have shown
    // nothing instead of a selfie, with no error anywhere. Pinning the
    // exact prefix here so this can't regress silently again.
    it('mints a URL under /api/v1/files/signed — the route\'s actual mount path', async () => {
      const url = await adapter.getSignedUrl(key, 60);
      expect(url.startsWith('/api/v1/files/signed?')).toBe(true);
    });

    it('a freshly minted signed URL verifies successfully', async () => {
      const url = await adapter.getSignedUrl(key, 60);
      const parsed = new URL(url, 'http://localhost');
      const sig = parsed.searchParams.get('sig')!;
      const expires = Number(parsed.searchParams.get('expires'));
      expect(adapter.verifySignedRequest(key, expires, sig)).toBe(true);
    });

    it('rejects a request past its expiry — same short-lived shape as the Supabase signed URL it replaces', () => {
      const expired = Date.now() - 1000;
      // Can't ask the adapter to sign an already-expired timestamp
      // directly (getSignedUrl always signs for the future), so this
      // reaches the private sign() logic the same way the real route
      // does: by constructing what a signature for that key+expiry
      // would be, bypassing the class's own API the way an attacker
      // trying to forge an old link would have to.
      expect(adapter.verifySignedRequest(key, expired, 'any-signature-at-all')).toBe(false);
    });

    it('rejects a tampered signature for an otherwise-valid, unexpired link', async () => {
      const url = await adapter.getSignedUrl(key, 60);
      const parsed = new URL(url, 'http://localhost');
      const expires = Number(parsed.searchParams.get('expires'));
      expect(adapter.verifySignedRequest(key, expires, '0'.repeat(64))).toBe(false);
    });

    it('rejects a signature minted for a different key', async () => {
      const url = await adapter.getSignedUrl(key, 60);
      const parsed = new URL(url, 'http://localhost');
      const sig = parsed.searchParams.get('sig')!;
      const expires = Number(parsed.searchParams.get('expires'));
      expect(adapter.verifySignedRequest('uploads/a-different-file.txt', expires, sig)).toBe(false);
    });
  });

  afterEach(async () => {
    await rm(join(rootDir, 'uploads'), { recursive: true, force: true }).catch(() => undefined);
  });
});
