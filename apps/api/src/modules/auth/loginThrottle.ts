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
// Client decision, 2026-08-22: first lockout is 5 minutes, second is 10,
// capped at 10 for every lockout after that — deliberately not
// continuing to escalate to hours/a full day the way the original
// 30min -> 2h -> 24h scale did. Math.min below already clamps
// durationIndex to the array's last entry, so a 2-element array is
// enough to express "capped at the 2nd value forever after" without a
// repeated third entry.
const LOCKOUT_ESCALATION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const LOCKOUT_DURATIONS_MS = [5 * 60 * 1000, 10 * 60 * 1000];

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
//
// Fails OPEN on infrastructure error: if reading AuditLog itself fails
// (a transient DB blip, not a security signal), that must not become an
// outage that blocks every login at the resort. This is a deliberate,
// asymmetric choice — the write side (logAudit, maybeLockAccount below)
// stays fail-CLOSED, because spec §4.4 makes audit logging "a hard
// requirement, not optional": a login that can't be recorded shouldn't
// silently succeed unaudited, but a lockout check that can't be *read*
// shouldn't silently deny everyone either. Real lockout enforcement is
// unaffected whenever the database is actually healthy; this only
// changes behavior during an unrelated outage, where the alternative is
// worse.
export async function assertNotLockedOrRateLimited(
  accountKey: string,
  ip: string | null | undefined,
): Promise<void> {
  const now = new Date();

  let activeLock: { after: unknown } | null;
  try {
    activeLock = await prisma.auditLog.findFirst({
      where: { action: 'ACCOUNT_LOCKED', entityId: accountKey },
      orderBy: { createdAt: 'desc' },
    });
  } catch {
    return;
  }
  if (activeLock) {
    const details = activeLock.after as LockoutDetails | null;
    const lockedUntil = details?.lockedUntil ? new Date(details.lockedUntil) : null;
    if (lockedUntil && lockedUntil > now) {
      throw lockedApiError(lockedUntil);
    }
  }

  const windowStart = new Date(now.getTime() - RATE_LIMIT_WINDOW_MS);

  // Two independent counters, not one shared one (client decision,
  // 2026-08-22, after live testing showed one account's lockout was
  // rate-limiting unrelated accounts sharing the same IP) — a busy shift
  // where several different staff each mistype their own password a
  // couple of times, on the resort's one shared IP, must not throttle
  // everyone else at the front desk. Each dimension gets its own
  // RATE_LIMIT_THRESHOLD, checked separately, and whichever one trips
  // reports its own retryAt (see the comment on the old combined query,
  // still true per-dimension: findMany + take, not count, because a
  // plain count can't say *when* the window clears).
  async function recentFailures(filter: { entityId: string } | { ip: string }): Promise<{ createdAt: Date }[]> {
    return prisma.auditLog.findMany({
      where: { action: 'LOGIN_FAILURE', createdAt: { gte: windowStart }, ...filter },
      orderBy: { createdAt: 'desc' },
      take: RATE_LIMIT_THRESHOLD,
      select: { createdAt: true },
    });
  }

  let accountFailures: { createdAt: Date }[];
  let ipFailures: { createdAt: Date }[] = [];
  try {
    accountFailures = await recentFailures({ entityId: accountKey });
    if (ip) {
      ipFailures = await recentFailures({ ip });
    }
  } catch {
    return;
  }

  const tripped = accountFailures.length >= RATE_LIMIT_THRESHOLD ? accountFailures : ipFailures;
  if (tripped.length >= RATE_LIMIT_THRESHOLD) {
    const oldestCounted = tripped[tripped.length - 1] as { createdAt: Date };
    const retryAt = new Date(oldestCounted.createdAt.getTime() + RATE_LIMIT_WINDOW_MS);
    throw new ApiError(429, 'RATE_LIMITED', 'Too many login attempts — try again in a few minutes.', {
      retryAt: retryAt.toISOString(),
    });
  }
}

// Called immediately after logging a LOGIN_FAILURE. If this failure
// pushes the account over the lockout threshold, locks it (writing a
// distinct, escalating-duration ACCOUNT_LOCKED entry) and throws — the
// caller finds out now, not on their next attempt.
//
// Deliberately fail-CLOSED, unlike the read side above: every DB call in
// here (the two counts, and logAudit's own write) is left to propagate as
// an unhandled rejection on failure. If the database is unreachable, this
// function not completing means the failed-login attempt that triggered it
// also fails closed (service.ts's login() has nothing to return), which is
// the correct side to fail on for a write that spec §4.4 treats as a hard
// requirement — better a login attempt errors out than a lockout write
// silently gets lost.
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
