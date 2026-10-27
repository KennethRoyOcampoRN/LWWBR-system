import type { CookieOptions, Request, Response } from 'express';
import { ACCESS_TOKEN_TTL_SECONDS, REFRESH_TOKEN_TTL_SECONDS } from './tokens.js';

// Spec §3: both tokens in httpOnly SameSite=Lax cookies.
const ACCESS_COOKIE = 'lwwbr_access';
const REFRESH_COOKIE = 'lwwbr_refresh';

function cookieOptions(path: string, maxAgeSeconds: number): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    // Secure requires HTTPS — off in local dev (plain http://localhost)
    // and on the LAN_MODE mini PC deployment (plain HTTP by deliberate
    // choice, spec.md §13 decision 11 — a Secure cookie would simply
    // never be sent over that connection and login would silently
    // break); on everywhere else real per spec §3.1.1 "Force HTTPS...
    // secure cookie flags." Reads process.env directly, not through
    // getEnv()'s cached singleton, so a test can flip NODE_ENV/LAN_MODE
    // per-case the same way forceHttps.test.ts does — see
    // forceHttps.ts's own comment on why.
    secure: process.env.NODE_ENV === 'production' && process.env.LAN_MODE !== 'true',
    path,
    maxAge: maxAgeSeconds * 1000,
  };
}

// The refresh cookie is scoped to /api/v1/auth only — it never needs to
// leave the browser on any other request, so it isn't sent on every API
// call the way the access cookie must be.
const REFRESH_COOKIE_PATH = '/api/v1/auth';

export function setAccessCookie(res: Response, token: string): void {
  res.cookie(ACCESS_COOKIE, token, cookieOptions('/', ACCESS_TOKEN_TTL_SECONDS));
}

export function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE, token, cookieOptions(REFRESH_COOKIE_PATH, REFRESH_TOKEN_TTL_SECONDS));
}

export function clearAuthCookies(res: Response): void {
  res.clearCookie(ACCESS_COOKIE, cookieOptions('/', 0));
  res.clearCookie(REFRESH_COOKIE, cookieOptions(REFRESH_COOKIE_PATH, 0));
}

export function getAccessCookie(req: Request): string | undefined {
  const cookies = req.cookies as Record<string, string> | undefined;
  return cookies?.[ACCESS_COOKIE];
}

export function getRefreshCookie(req: Request): string | undefined {
  const cookies = req.cookies as Record<string, string> | undefined;
  return cookies?.[REFRESH_COOKIE];
}
