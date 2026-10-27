import { timingSafeEqual, createHmac } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { StorageAdapter, StoredFile } from './types.js';

// Client decision, 2026-10-27 (spec.md §13 decision 11): local self-
// hosting on a mini PC — files/service.ts's storageKey (always server-
// generated, randomUUID-prefixed, never client-controlled) becomes a
// relative path under rootDir.
//
// getSignedUrl() is the one place the Supabase implementation's shape
// doesn't translate directly: Supabase hands back a URL on its own
// storage host, served independently of this API. There's no separate
// host here, so this mints a URL back at this same API — a relative
// path, since the API now serves both the SPA and itself from one
// origin — carrying an HMAC-signed key+expiry that GET /files/signed
// (files/router.ts) verifies before streaming the file. Same security
// shape as what ships today (short-lived, unguessable, not session-
// gated) — not the stricter, session-authenticated route spec §3.1.1
// describes but that was never actually built (see README for that
// pre-existing gap, unrelated to this migration).
export class LocalDiskStorageAdapter implements StorageAdapter {
  constructor(
    private readonly rootDir: string,
    private readonly signingSecret: string,
  ) {}

  private resolvePath(key: string): string {
    const normalized = key.replace(/\\/g, '/').replace(/^\/+/, '');
    if (normalized.includes('..')) {
      throw new Error(`Refusing to resolve a storage key containing "..": "${key}"`);
    }
    return join(this.rootDir, normalized);
  }

  async upload(params: { key: string; buffer: Buffer; contentType: string }): Promise<StoredFile> {
    const path = this.resolvePath(params.key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, params.buffer);
    return { key: params.key, sizeBytes: params.buffer.byteLength, contentType: params.contentType };
  }

  async download(key: string): Promise<Buffer> {
    return readFile(this.resolvePath(key));
  }

  async getSignedUrl(key: string, expiresInSeconds = 300): Promise<string> {
    const expires = Date.now() + expiresInSeconds * 1000;
    const sig = this.sign(key, expires);
    // GET /files/signed is mounted under /api/v1 like every other route
    // in this app (app.ts: `app.use('/api/v1', filesRouter)`) — this
    // must match that mount path exactly, found missing it the hard way
    // during manual end-to-end verification (the link resolved to the
    // SPA's own index.html fallback instead of the file).
    return `/api/v1/files/signed?key=${encodeURIComponent(key)}&expires=${expires}&sig=${sig}`;
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolvePath(key), { force: true });
  }

  private sign(key: string, expires: number): string {
    return createHmac('sha256', this.signingSecret).update(`${key}:${expires}`).digest('hex');
  }

  /** Used by GET /files/signed (files/router.ts) to validate a link before streaming. */
  verifySignedRequest(key: string, expires: number, sig: string): boolean {
    if (!Number.isFinite(expires) || Date.now() > expires) return false;
    const expected = Buffer.from(this.sign(key, expires));
    const provided = Buffer.from(sig);
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  }
}
