import type { NextFunction, Request, Response } from 'express';
import { ApiError } from './apiError.js';

// Spec §3.1.1: "Force HTTPS... Reject non-TLS." Gated to production only
// — local dev is plain http://localhost and must stay reachable. Netlify
// terminates TLS in front of the function and sets x-forwarded-proto;
// req.secure alone isn't reliable behind that kind of proxy. Netlify's
// own CDN edge already redirects http->https before a request reaches
// the function at all, so this is defense in depth, not the only layer.
export function forceHttps(req: Request, _res: Response, next: NextFunction): void {
  if (process.env.NODE_ENV !== 'production') {
    next();
    return;
  }
  const proto = req.headers['x-forwarded-proto'];
  const isHttps = req.secure || proto === 'https';
  if (!isHttps) {
    throw new ApiError(403, 'HTTPS_REQUIRED', 'HTTPS is required.');
  }
  next();
}
