import { ApiError } from '../../lib/apiError.js';
import { logAudit } from '../../lib/auditLog.js';
import { prisma } from '../../lib/prisma.js';

// Spec §3.1.1: "Rate limiting on /auth/login (per IP and per account)
// and progressive lockout after repeated failures." All state lives in
// Postgres — AuditLog, which already records every LOGIN_FAILURE entry
// (see service.ts) — rather than in memory. Spec §3.1's serverless rule
// is the reason: a module-level counter resets on every cold start,
// which would make rate limiting silently do nothing in production.

// Fast per-request throttle: a short window, low threshold, catches
// rapid-fire brute-force before it ever reaches password verification.
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_THRESHOLD = 5;

// Progressive lockout: spec's own M1 acceptance number ("10 failed
// logins lock the account").
const LOCKOUT_FAILURE_WINDOW_MS = 60 * 60 * 1000;
const LOCKOUT_FAILURE_THRESHOLD = 10;

// Escalates each time an account is locked again within this window.
const LOCKOUT_ESCALATION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const LOCKOUT_DURATIONS_MS = [30 * 60 * 1000, 2 * 60 * 60 * 1000, 24 * 60 * 60 * 1000];

interface LockoutDetails {
  lockedUntil?: string;
}

function lockedApiError(lockedUntil: Date): ApiError {
  return new ApiError(423, 'ACCOUNT_LOCKED', 'Account temporarily locked after repeated failed logins.', {
    lockedUntil: lockedUntil.toISOString(),
  });
}

// Called before password verification. Throws if the account is
// currently under an active lockout, or if the fast rate-limit threshold
// has been hit — in either case the caller should never learn whether
// the password would have been correct.
export async function assertNotLockedOrRateLimited(
  accountKey: string,
  ip: string | null | undefined,
): Promise<void> {
  const now = new Date();

  const activeLock = await prisma.auditLog.findFirst({
    where: { action: 'ACCOUNT_LOCKED', entityId: accountKey },
    orderBy: { createdAt: 'desc' },
  });
  if (activeLock) {
    const details = activeLock.after as LockoutDetails | null;
    const lockedUntil = details?.lockedUntil ? new Date(details.lockedUntil) : null;
    if (lockedUntil && lockedUntil > now) {
      throw lockedApiError(lockedUntil);
    }
  }

  const windowStart = new Date(now.getTime() - RATE_LIMIT_WINDOW_MS);
  const recentFailures = await prisma.auditLog.count({
    where: {
      action: 'LOGIN_FAILURE',
      createdAt: { gte: windowStart },
      OR: [{ entityId: accountKey }, ...(ip ? [{ ip }] : [])],
    },
  });
  if (recentFailures >= RATE_LIMIT_THRESHOLD) {
    throw new ApiError(429, 'RATE_LIMITED', 'Too many login attempts — try again in a few minutes.');
  }
}

// Called immediately after logging a LOGIN_FAILURE. If this failure
// pushes the account over the lockout threshold, locks it (writing a
// distinct, escalating-duration ACCOUNT_LOCKED entry) and throws — the
// caller finds out now, not on their next attempt.
export async function maybeLockAccount(
  accountKey: string,
  meta: { ip?: string | null; userAgent?: string | null },
): Promise<void> {
  const now = new Date();

  const failureWindowStart = new Date(now.getTime() - LOCKOUT_FAILURE_WINDOW_MS);
  const recentFailureCount = await prisma.auditLog.count({
    where: { action: 'LOGIN_FAILURE', entityId: accountKey, createdAt: { gte: failureWindowStart } },
  });
  if (recentFailureCount < LOCKOUT_FAILURE_THRESHOLD) {
    return;
  }

  const escalationWindowStart = new Date(now.getTime() - LOCKOUT_ESCALATION_WINDOW_MS);
  const priorLockouts = await prisma.auditLog.count({
    where: { action: 'ACCOUNT_LOCKED', entityId: accountKey, createdAt: { gte: escalationWindowStart } },
  });
  const durationIndex = Math.min(priorLockouts, LOCKOUT_DURATIONS_MS.length - 1);
  const duration = LOCKOUT_DURATIONS_MS[durationIndex] as number;
  const lockedUntil = new Date(now.getTime() + duration);

  await logAudit({
    actorId: null,
    action: 'ACCOUNT_LOCKED',
    entity: 'User',
    entityId: accountKey,
    after: { lockedUntil: lockedUntil.toISOString(), failureCount: recentFailureCount },
    ip: meta.ip,
    userAgent: meta.userAgent,
  });

  throw lockedApiError(lockedUntil);
}
