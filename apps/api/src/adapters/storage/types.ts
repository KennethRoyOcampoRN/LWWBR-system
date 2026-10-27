// File storage interface — spec §3 / §3.1.1. Never exposes a public bucket
// URL; every read goes through a signed, short-lived URL. Two
// implementations: Supabase Storage (cloud) and local disk (self-hosted,
// spec.md §13 decision 11) — selected by STORAGE_ADAPTER.

export interface StoredFile {
  key: string;
  sizeBytes: number;
  contentType: string;
}

export interface StorageAdapter {
  upload(params: { key: string; buffer: Buffer; contentType: string }): Promise<StoredFile>;
  download(key: string): Promise<Buffer>;
  /** Short-lived signed URL — never a permanent public link. */
  getSignedUrl(key: string, expiresInSeconds?: number): Promise<string>;
  delete(key: string): Promise<void>;
}
