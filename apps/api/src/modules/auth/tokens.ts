import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { getEnv } from '../../lib/env.js';

// Spec §3: access token (15 min) + refresh token (7 days).
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface AccessTokenPayload {
  sub: string; // userId
}

// The access token carries only the user id, nothing about roles or
// permissions — those are looked up fresh from the database on every
// request (see requireAuth/requirePermission). A 15-minute-old cached
// permission set is an accepted staleness window (that's exactly why the
// token is short-lived); a 15-minute-old cached *identity* is not the
// same trade and isn't worth the token-forging surface of embedding more.
export function signAccessToken(userId: string): string {
  const { JWT_SECRET } = getEnv();
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: ACCESS_TOKEN_TTL_SECONDS });
}

export function verifyAccessToken(token: string): AccessTokenPayload | null {
  const { JWT_SECRET } = getEnv();
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (typeof decoded === 'string' || typeof decoded.sub !== 'string') return null;
    return { sub: decoded.sub };
  } catch {
    return null;
  }
}

// Refresh tokens are opaque random secrets, not JWTs — Session.
// refreshTokenHash stores a hash of one so a database leak doesn't hand
// out usable tokens directly. Hashed with SHA-256, not argon2: argon2 is
// for low-entropy user passwords that need brute-force resistance; a
// 48-byte random token is already high-entropy, so a fast deterministic
// hash (needed anyway, to look the session up by hash equality) is the
// right tool here, not the wrong one.
export function generateRefreshToken(): string {
  return randomBytes(48).toString('hex');
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
