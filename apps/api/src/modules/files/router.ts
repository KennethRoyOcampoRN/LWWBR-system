import { Router } from 'express';
import multer from 'multer';
import { getStorageAdapter, LocalDiskStorageAdapter } from '../../adapters/storage/index.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { ApiError } from '../../lib/apiError.js';
import { prisma } from '../../lib/prisma.js';
import { requireAuth } from '../auth/middleware.js';
import { ALLOWED_FILE_MIME_TYPES, MAX_FILE_SIZE_BYTES, uploadFile } from './service.js';

// Memory storage, not disk — the buffer goes straight to
// StorageAdapter.upload(), which is the only thing that decides where a
// file actually lands (Supabase Storage, or local disk per
// LocalDiskStorageAdapter). Originally required by the serverless
// target (spec §3.1: "write serverless-safe code from day one" — no
// local filesystem persists between invocations there); works
// unchanged on the long-running self-hosted server too, so there was no
// reason to change it for spec.md §13 decision 11.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_FILE_MIME_TYPES.includes(file.mimetype as (typeof ALLOWED_FILE_MIME_TYPES)[number])) {
      cb(new ApiError(422, 'UNSUPPORTED_MEDIA_TYPE', `Unsupported file type "${file.mimetype}"`));
      return;
    }
    cb(null, true);
  },
});

export const filesRouter = Router();

// requireAuth only, not a specific permission: this is a generic upload
// endpoint reused across future modules (work-order photos today,
// check-in waivers / payment proofs / receipts later), each gated by its
// own domain permission when it *attaches* the uploaded file to
// something — uploading a raw file to your own account isn't itself a
// privileged action. Reading a file back is scoped by whichever module
// embeds it (e.g. GET /work-orders/:id only returns photo URLs to a
// caller who already holds workorder:read for that ticket) rather than
// through a second generic /files/:id route — see README for why a
// fully generic read route wasn't built this slice.
filesRouter.post(
  '/files',
  requireAuth,
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'No file uploaded — expected a multipart field named "file".');
    }
    const file = await uploadFile({
      buffer: req.file.buffer,
      filename: req.file.originalname,
      mimeType: req.file.mimetype,
      uploaderId: req.userId as string,
    });
    res.status(201).json({ file });
  }),
);

// Client decision, 2026-10-27 (spec.md §13 decision 11): the local-disk
// StorageAdapter's getSignedUrl() mints a link back at this route rather
// than at a separate storage host (there isn't one self-hosted) — see
// localDiskStorageAdapter.ts's own header comment. Deliberately public,
// no requireAuth: this URL is handed out raw as an <a href>/<img src>,
// the same way Supabase's own signed URL is today (confirmed via
// ShiftsPage.tsx), so a session cookie can't be assumed here — the
// signature + expiry *is* the credential, same security shape as what
// already ships, not a regression. A no-op (404) when STORAGE_ADAPTER
// is 'supabase', since that adapter's signed URLs never point here.
filesRouter.get(
  '/files/signed',
  asyncHandler(async (req, res) => {
    const adapter = getStorageAdapter();
    if (!(adapter instanceof LocalDiskStorageAdapter)) {
      throw new ApiError(404, 'NOT_FOUND', 'Route not found');
    }
    const key = req.query.key;
    const expires = Number(req.query.expires);
    const sig = req.query.sig;
    if (typeof key !== 'string' || typeof sig !== 'string' || !adapter.verifySignedRequest(key, expires, sig)) {
      throw new ApiError(403, 'LINK_EXPIRED_OR_INVALID', 'This file link has expired or is invalid.');
    }
    const file = await prisma.fileObject.findFirst({ where: { storageKey: key, deletedAt: null } });
    if (!file) {
      throw new ApiError(404, 'NOT_FOUND', 'File not found');
    }
    const buffer = await adapter.download(key);
    res.set('Content-Type', file.mimeType);
    res.set('Cache-Control', 'private, max-age=60');
    res.send(buffer);
  }),
);
