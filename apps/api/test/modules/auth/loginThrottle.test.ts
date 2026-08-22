import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPrisma = {
  auditLog: { create: vi.fn(), count: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
};

vi.mock('../../../src/lib/prisma.js', () => ({ prisma: mockPrisma }));

const { assertNotLockedOrRateLimited, maybeLockAccount } = await import(
  '../../../src/modules/auth/loginThrottle.js'
);

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.auditLog.findFirst.mockResolvedValue(null);
  mockPrisma.auditLog.count.mockResolvedValue(0);
  mockPrisma.auditLog.findMany.mockResolvedValue([]);
});

describe('maybeLockAccount — escalating durations (client decision, 2026-08-22)', () => {
  function mockFailureAndPriorLockoutCounts(failureCount: number, priorLockouts: number) {
    mockPrisma.auditLog.count.mockImplementation(({ where }: { where: { action: string } }) => {
      if (where.action === 'LOGIN_FAILURE') return Promise.resolve(failureCount);
      if (where.action === 'ACCOUNT_LOCKED') return Promise.resolve(priorLockouts);
      return Promise.resolve(0);
    });
  }

  it('locks for 5 minutes on the first lockout (no prior ACCOUNT_LOCKED entries)', async () => {
    mockFailureAndPriorLockoutCounts(10, 0);
    const before = Date.now();

    await expect(maybeLockAccount('user_1', {})).rejects.toMatchObject({ status: 423 });

    const call = mockPrisma.auditLog.create.mock.calls[0]?.[0] as { data: { after: { lockedUntil: string } } };
    const lockedUntilMs = new Date(call.data.after.lockedUntil).getTime();
    expect(lockedUntilMs - before).toBeGreaterThan(4.9 * 60 * 1000);
    expect(lockedUntilMs - before).toBeLessThanOrEqual(5 * 60 * 1000 + 1000);
  });

  it('locks for 10 minutes on the second consecutive lockout', async () => {
    mockFailureAndPriorLockoutCounts(10, 1);
    const before = Date.now();

    await expect(maybeLockAccount('user_1', {})).rejects.toMatchObject({ status: 423 });

    const call = mockPrisma.auditLog.create.mock.calls[0]?.[0] as { data: { after: { lockedUntil: string } } };
    const lockedUntilMs = new Date(call.data.after.lockedUntil).getTime();
    expect(lockedUntilMs - before).toBeGreaterThan(9.9 * 60 * 1000);
    expect(lockedUntilMs - before).toBeLessThanOrEqual(10 * 60 * 1000 + 1000);
  });

  it('stays capped at 10 minutes for a third, fourth, or later lockout — no further escalation to hours/24h', async () => {
    for (const priorLockouts of [2, 3, 10]) {
      mockFailureAndPriorLockoutCounts(10, priorLockouts);
      const before = Date.now();

      await expect(maybeLockAccount('user_1', {})).rejects.toMatchObject({ status: 423 });

      const call = mockPrisma.auditLog.create.mock.calls[0]?.[0] as { data: { after: { lockedUntil: string } } };
      const lockedUntilMs = new Date(call.data.after.lockedUntil).getTime();
      expect(lockedUntilMs - before).toBeLessThanOrEqual(10 * 60 * 1000 + 1000);
    }
  });
});

describe('assertNotLockedOrRateLimited — independent account and IP counters (client decision, 2026-08-22)', () => {
  it('blocks on the account counter alone, with no IP present', async () => {
    const failures = Array.from({ length: 5 }, (_, i) => ({ createdAt: new Date(Date.now() - i * 1000) }));
    mockPrisma.auditLog.findMany.mockImplementation(({ where }: { where: { entityId?: string; ip?: string } }) => {
      if (where.entityId === 'user_a') return Promise.resolve(failures);
      return Promise.resolve([]);
    });

    await expect(assertNotLockedOrRateLimited('user_a', null)).rejects.toMatchObject({
      status: 429,
      code: 'RATE_LIMITED',
    });
  });

  it('does not block a clean account merely because a DIFFERENT account has failures on the same IP being under its own threshold', async () => {
    // 4 IP-scoped failures (all against some other account) — under the
    // threshold of 5, so this account, which has none of its own, must
    // pass through to password verification.
    const ipFailures = Array.from({ length: 4 }, (_, i) => ({ createdAt: new Date(Date.now() - i * 1000) }));
    mockPrisma.auditLog.findMany.mockImplementation(({ where }: { where: { entityId?: string; ip?: string } }) => {
      if (where.ip === '10.0.0.5') return Promise.resolve(ipFailures);
      return Promise.resolve([]);
    });

    await expect(assertNotLockedOrRateLimited('user_clean', '10.0.0.5')).resolves.toBeUndefined();
  });

  it('does block a clean account once the shared IP itself has hit the threshold, regardless of which account those failures targeted', async () => {
    // This is deliberate, not a leftover of the old shared-counter bug:
    // per-IP throttling exists specifically to catch failures spread
    // across many different accounts from one IP (credential stuffing).
    // The independent-counters change removed the OLD cross-contamination
    // (a fresh account inheriting another account's failures merely by
    // being checked from the OR'd query), not IP-level throttling itself.
    const ipFailures = Array.from({ length: 5 }, (_, i) => ({ createdAt: new Date(Date.now() - i * 1000) }));
    mockPrisma.auditLog.findMany.mockImplementation(({ where }: { where: { entityId?: string; ip?: string } }) => {
      if (where.ip === '10.0.0.5') return Promise.resolve(ipFailures);
      return Promise.resolve([]);
    });

    await expect(assertNotLockedOrRateLimited('user_clean', '10.0.0.5')).rejects.toMatchObject({
      status: 429,
      code: 'RATE_LIMITED',
    });
  });
});

describe('reproducing the reported "15 minutes on two different accounts" report', () => {
  it('proves this was the 429 rate limiter (15-min window), not the 423 lockout (5/10-min tiers) -- and that it is the intended IP-throttle behavior, not shared/broken state', async () => {
    // Exactly what 5 rapid wrong-password attempts against LWW-006
    // produces: 5 LOGIN_FAILURE rows, each carrying both the account's
    // own entityId AND the shared front-desk IP.
    const sharedIp = '10.0.0.9';
    const failureRows = Array.from({ length: 5 }, (_, i) => ({ createdAt: new Date(Date.now() - i * 1000) }));

    mockPrisma.auditLog.findMany.mockImplementation(
      ({ where }: { where: { entityId?: string; ip?: string } }) => {
        // LWW-006's own account-scoped query sees its 5 failures.
        if (where.entityId === 'user_006') return Promise.resolve(failureRows);
        // The IP-scoped query sees the SAME 5 rows, because every one of
        // LWW-006's failures also carries this ip -- this is the one
        // shared dimension by design (per-IP throttling), not a bug.
        if (where.ip === sharedIp) return Promise.resolve(failureRows);
        // LWW-014's own account-scoped query: genuinely untouched.
        if (where.entityId === 'user_014') return Promise.resolve([]);
        return Promise.resolve([]);
      },
    );

    const expectedRetryAt = new Date(
      (failureRows[failureRows.length - 1] as { createdAt: Date }).createdAt.getTime() + 15 * 60 * 1000,
    );

    // LWW-006 itself: rate-limited via its own account counter.
    await expect(assertNotLockedOrRateLimited('user_006', sharedIp)).rejects.toMatchObject({
      status: 429,
      code: 'RATE_LIMITED',
      details: { retryAt: expectedRetryAt.toISOString() },
    });

    // LWW-014, never itself failed, from the same IP: rate-limited via
    // the IP counter -- with the SAME retryAt, because it's built from
    // the exact same underlying failure rows. This is what "identical
    // countdown on two different accounts" actually was: correct
    // per-IP throttling, not the account/IP split failing to apply.
    await expect(assertNotLockedOrRateLimited('user_014', sharedIp)).rejects.toMatchObject({
      status: 429,
      code: 'RATE_LIMITED',
      details: { retryAt: expectedRetryAt.toISOString() },
    });

    // And to be unambiguous: neither of these ever touched
    // maybeLockAccount or LOCKOUT_DURATIONS_MS at all -- the 5/10-minute
    // tiers from the last commit were never exercised by this scenario.
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
  });
});
