import { Router } from 'express';
import multer from 'multer';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { ApiError } from '../../lib/apiError.js';
import { requireAuth } from '../auth/middleware.js';
import { ALLOWED_FILE_MIME_TYPES, MAX_FILE_SIZE_BYTES, uploadFile } from './service.js';

// Memory storage, not disk — this is a serverless-target API (spec §3.1:
// "write serverless-safe code from day one"), so nothing should touch a
// local filesystem that won't exist between invocations. The buffer goes
// straight to StorageAdapter.upload().
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
