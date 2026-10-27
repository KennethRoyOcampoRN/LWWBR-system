import type { NextFunction, Request, Response } from 'express';
import { ApiError } from './apiError.js';

// Spec §3.1.1: "Force HTTPS... Reject non-TLS." Gated to production only
// — local dev is plain http://localhost and must stay reachable. Netlify
// terminates TLS in front of the function and sets x-forwarded-proto;
// req.secure alone isn't reliable behind that kind of proxy. Netlify's
// own CDN edge already redirects http->https before a request reaches
// the function at all, so this is defense in depth, not the only layer.
//
// Client decision, 2026-10-27 (spec.md §13 decision 11): LAN_MODE is a
// second, explicit gate alongside NODE_ENV — the mini PC deployment runs
// with NODE_ENV=production (for every other production behavior: no
// stack traces, etc.) but deliberately plain HTTP on a closed LAN, with
// credential exposure mitigated by putting staff devices on their own
// wifi SSID (see docs/local-hosting-setup.md), not by TLS. This is an
// opt-in flag, not a loosened default — a cloud deployment that never
// sets LAN_MODE keeps forcing HTTPS exactly as before. Reads
// process.env directly rather than through getEnv()'s cached singleton
// — this file's own test (forceHttps.test.ts) flips NODE_ENV/LAN_MODE
// per-test, which a cached getEnv() read would silently ignore after
// its first call.
export function forceHttps(req: Request, _res: Response, next: NextFunction): void {
  if (process.env.NODE_ENV !== 'production' || process.env.LAN_MODE === 'true') {
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
