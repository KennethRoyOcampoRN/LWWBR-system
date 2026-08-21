import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../../lib/apiError.js';
import { getAccessCookie } from './cookies.js';
import { verifyAccessToken } from './tokens.js';

// requirePermission (a follow-up task) builds on this: requireAuth
// establishes *who* is calling; requirePermission additionally checks
// *what* they're allowed to do, by loading their current roles fresh
// from the database rather than trusting anything cached in the token.
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const token = getAccessCookie(req);
  const payload = token ? verifyAccessToken(token) : null;
  if (!payload) {
    throw new ApiError(401, 'UNAUTHENTICATED', 'Not authenticated');
  }
  req.userId = payload.sub;
  next();
}
