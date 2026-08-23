import { randomUUID } from 'node:crypto';
import { getStorageAdapter } from '../../adapters/storage/index.js';
import { ApiError } from '../../lib/apiError.js';
import { prisma } from '../../lib/prisma.js';

// Spec §7.2.1: "Max 10MB per file post-compression; reject other MIME
// types than image/jpeg|png|webp|heic." Stated for work-order photos
// specifically, but this is the one generic upload endpoint every future
// photo-evidence module (check-in waivers, payment proofs, receipts)
// reuses — applying the same allowlist everywhere is a deliberate
// simplification for now rather than a per-caller configurable one; a
// module with genuinely different needs (e.g. a PDF receipt) would need
// its own allowlist when it's actually built, not a speculative one now.
export const ALLOWED_FILE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'] as const;
export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

export interface UploadedFile {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

export async function uploadFile(params: {
  buffer: Buffer;
  filename: string;
  mimeType: string;
  uploaderId: string;
}): Promise<UploadedFile> {
  if (!ALLOWED_FILE_MIME_TYPES.includes(params.mimeType as (typeof ALLOWED_FILE_MIME_TYPES)[number])) {
    throw new ApiError(
      422,
      'UNSUPPORTED_MEDIA_TYPE',
      `Unsupported file type "${params.mimeType}" — only JPEG, PNG, WebP, or HEIC images are accepted.`,
    );
  }
  if (params.buffer.byteLength > MAX_FILE_SIZE_BYTES) {
    throw new ApiError(422, 'FILE_TOO_LARGE', 'File exceeds the 10MB limit.');
  }

  // storageKey is never derived from the client-supplied filename alone
  // — randomUUID prevents both collisions and path-injection from a
  // hostile filename, while the original name is kept only as display
  // metadata on the FileObject row.
  const storageKey = `uploads/${randomUUID()}-${params.filename.replace(/[^\w.-]/g, '_')}`;

  const stored = await getStorageAdapter().upload({
    key: storageKey,
    buffer: params.buffer,
    contentType: params.mimeType,
  });

  const file = await prisma.fileObject.create({
    data: {
      filename: params.filename,
      mimeType: params.mimeType,
      sizeBytes: stored.sizeBytes,
      storageKey: stored.key,
      uploadedById: params.uploaderId,
    },
  });

  return { id: file.id, filename: file.filename, mimeType: file.mimeType, sizeBytes: file.sizeBytes };
}
