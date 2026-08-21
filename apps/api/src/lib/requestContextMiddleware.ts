import type { NextFunction, Request, Response } from 'express';
import { runWithRequestContext } from './requestContext.js';

// Mounted early in app.ts, before any router — opens the per-request
// context that the audit Prisma extension reads from. actorId starts
// null and is filled in by requireAuth/requirePermission once the caller
// is identified; ip/userAgent are known immediately.
export function attachRequestContext(req: Request, _res: Response, next: NextFunction): void {
  runWithRequestContext({ actorId: null, ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null }, next);
}
