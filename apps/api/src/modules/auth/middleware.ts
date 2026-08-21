import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../../lib/apiError.js';
import { setRequestActorId } from '../../lib/requestContext.js';
import { getAccessCookie } from './cookies.js';
import { verifyAccessToken } from './tokens.js';

// Shared by requireAuth and requirePermission — resolves the calling
// user's id from the access token cookie, or throws 401. Also records the
// actor into the request context so any Prisma writes later in this
// request are attributed correctly in the audit log.
export function getAuthenticatedUserId(req: Request): string {
  const token = getAccessCookie(req);
  const payload = token ? verifyAccessToken(token) : null;
  if (!payload) {
    throw new ApiError(401, 'UNAUTHENTICATED', 'Not authenticated');
  }
  setRequestActorId(payload.sub);
  return payload.sub;
}

// Confirms identity only — used where no specific permission applies
// (GET /auth/me). requirePermission (requirePermission.ts) is the base
// for everything else: it additionally checks *what* the caller is
// allowed to do, loading their current roles fresh from the database
// rather than trusting anything cached in the token.
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  req.userId = getAuthenticatedUserId(req);
  next();
}
