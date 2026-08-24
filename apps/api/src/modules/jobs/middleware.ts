import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../../lib/apiError.js';
import { getEnv } from '../../lib/env.js';

// Spec §3.1: the amenity-overdue sweep and owner digest are "plain
// authenticated HTTP endpoints... protected by a shared secret header,"
// called by a Netlify Scheduled Function in production and triggered by
// hand in local dev — never a setInterval (see §3.1's own reasoning:
// "a setInterval in a serverless function simply never fires"). This is
// deliberately a header secret, not requirePermission/req.userId — the
// caller here is a scheduler, not a logged-in user, so there's no
// session to authenticate.
//
// timingSafeEqual over a plain `===`: this header is effectively a
// bearer credential exposed on the public internet (spec §3.1.1 — every
// endpoint is internet-facing), and a naive string comparison leaks
// timing information proportional to the matching prefix length. Length
// is checked first (timingSafeEqual throws, rather than returning false,
// on mismatched buffer lengths) — that comparison itself doesn't need to
// be constant-time, since the secret's length isn't the secret.
export function requireJobSecret(req: Request, _res: Response, next: NextFunction): void {
  const configured = getEnv().JOB_SECRET;
  if (!configured) {
    throw new ApiError(500, 'JOB_SECRET_NOT_CONFIGURED', 'JOB_SECRET is not configured on this server.');
  }

  const provided = req.get('x-job-secret');
  const configuredBuf = Buffer.from(configured);
  const providedBuf = Buffer.from(provided ?? '');
  const matches = providedBuf.length === configuredBuf.length && timingSafeEqual(providedBuf, configuredBuf);
  if (!matches) {
    throw new ApiError(401, 'UNAUTHENTICATED', 'Missing or invalid job secret.');
  }

  next();
}
