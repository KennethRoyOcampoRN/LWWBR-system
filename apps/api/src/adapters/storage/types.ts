// File storage interface — spec §3 / §3.1.1. Never exposes a public bucket
// URL; every read goes through the authenticated /files/:id route. MVP
// ships the Supabase implementation only; a local-disk implementation is
// not built (spec §3.1).

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
