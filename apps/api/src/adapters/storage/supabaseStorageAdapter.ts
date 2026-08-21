import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { StorageAdapter, StoredFile } from './types.js';

export class SupabaseStorageAdapter implements StorageAdapter {
  private readonly client: SupabaseClient;
  private readonly bucket: string;

  constructor(supabaseUrl: string, serviceRoleKey: string, bucket: string) {
    this.client = createClient(supabaseUrl, serviceRoleKey);
    this.bucket = bucket;
  }

  async upload(params: { key: string; buffer: Buffer; contentType: string }): Promise<StoredFile> {
    const { data, error } = await this.client.storage
      .from(this.bucket)
      .upload(params.key, params.buffer, {
        contentType: params.contentType,
        upsert: false,
      });

    if (error || !data) {
      throw new Error(`Storage upload failed for "${params.key}": ${error?.message}`);
    }

    return {
      key: data.path,
      sizeBytes: params.buffer.byteLength,
      contentType: params.contentType,
    };
  }

  async download(key: string): Promise<Buffer> {
    const { data, error } = await this.client.storage.from(this.bucket).download(key);
    if (error || !data) {
      throw new Error(`Storage download failed for "${key}": ${error?.message}`);
    }
    const arrayBuffer = await data.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  async getSignedUrl(key: string, expiresInSeconds = 300): Promise<string> {
    const { data, error } = await this.client.storage
      .from(this.bucket)
      .createSignedUrl(key, expiresInSeconds);

    if (error || !data) {
      throw new Error(`Storage signed URL failed for "${key}": ${error?.message}`);
    }
    return data.signedUrl;
  }

  async delete(key: string): Promise<void> {
    const { error } = await this.client.storage.from(this.bucket).remove([key]);
    if (error) {
      throw new Error(`Storage delete failed for "${key}": ${error.message}`);
    }
  }
}
