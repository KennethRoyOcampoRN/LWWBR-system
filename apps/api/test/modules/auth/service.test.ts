import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hashPassword } from '../../../src/modules/auth/passwords.js';
import { verifyAccessToken } from '../../../src/modules/auth/tokens.js';
import { generateTotpSecret, verifyTotpCode } from '../../../src/modules/auth/totp.js';

const mockPrisma = {
  user: { findFirst: vi.fn(), update: vi.fn() },
  session: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  auditLog: { create: vi.fn(), count: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
};

// Mocked so these tests exercise the real password/token/TOTP logic
// (argon2, JWT signing, otpauth) against a fake persistence layer
// instead of a real database — no network dependency, and it runs the
// same everywhere.
vi.mock('../../../src/lib/prisma.js', () => ({ prisma: mockPrisma }));

const { login, refresh, logout, getMe, listSessions, revokeSession, changePassword } = await import(
  '../../../src/modules/auth/service.js'
);

function fakeUser(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'user_1',
    employeeCode: 'LWW-001',
    fullName: 'Resort Manager (Demo)',
    email: null,
    department: 'MANAGEMENT',
    isActive: true,
    mustChangePassword: true,
    totpSecret: null,
    deletedAt: null,
    roles: [{ role: { key: 'RESORT_MANAGER' } }],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Defaults so tests unrelated to throttling/lockout don't need to know
  // about it: no active lock, no recent failures.
  mockPrisma.auditLog.findFirst.mockResolvedValue(null);
  mockPrisma.auditLog.count.mockResolvedValue(0);
  mockPrisma.auditLog.findMany.mockResolvedValue([]);
});

describe('login', () => {
  it('succeeds with the correct password, creates a session, and audits success', async () => {
    const passwordHash = await hashPassword('Waku2026!');
    mockPrisma.user.findFirst.mockResolvedValue(fakeUser({ passwordHash }));

    const result = await login('LWW-001', 'Waku2026!', { ip: '127.0.0.1', userAgent: 'vitest' });
    if (result.status !== 'success') throw new Error('expected success');

    expect(result.user.employeeCode).toBe('LWW-001');
    expect(result.user.roles).toEqual(['RESORT_MANAGER']);
    expect(result.user.permissions['unit:update_status']).toBe('ALL');
    expect(verifyAccessToken(result.accessToken)?.sub).toBe('user_1');
    expect(result.refreshToken).toMatch(/^[0-9a-f]{96}$/);

    expect(mockPrisma.session.create).toHaveBeenCalledOnce();
    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user_1' },
      data: { lastLoginAt: expect.any(Date) },
    });
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'LOGIN_SUCCESS', actorId: 'user_1' }) }),
    );
  });

  it('rejects a wrong password without revealing which part was wrong, and audits the failure', async () => {
    const passwordHash = await hashPassword('Waku2026!');
    mockPrisma.user.findFirst.mockResolvedValue(fakeUser({ passwordHash }));

    await expect(login('LWW-001', 'wrong-password', {})).rejects.toMatchObject({
      status: 401,
      code: 'INVALID_CREDENTIALS',
    });
    expect(mockPrisma.session.create).not.toHaveBeenCalled();
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'LOGIN_FAILURE', actorId: 'user_1' }) }),
    );
  });

  it('rejects an unknown employeeCode with the identical error as a wrong password', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(null);

    await expect(login('NO-SUCH-CODE', 'anything', {})).rejects.toMatchObject({
      status: 401,
      code: 'INVALID_CREDENTIALS',
    });
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'LOGIN_FAILURE', actorId: null, entityId: 'NO-SUCH-CODE' }),
      }),
    );
  });

  it('rejects an inactive user even with the correct password', async () => {
    const passwordHash = await hashPassword('Waku2026!');
    mockPrisma.user.findFirst.mockResolvedValue(fakeUser({ passwordHash, isActive: false }));

    await expect(login('LWW-001', 'Waku2026!', {})).rejects.toMatchObject({ status: 401 });
    expect(mockPrisma.session.create).not.toHaveBeenCalled();
  });

  describe('rate limiting and lockout (spec §3.1.1)', () => {
    it('rejects with 429 once 5 recent failures exist for this account, before ever checking the password', async () => {
      const passwordHash = await hashPassword('Waku2026!');
      mockPrisma.user.findFirst.mockResolvedValue(fakeUser({ passwordHash }));
      // >= RATE_LIMIT_THRESHOLD, newest first, as the real query orders them.
      mockPrisma.auditLog.findMany.mockResolvedValue([
        { createdAt: new Date(Date.now() - 1_000) },
        { createdAt: new Date(Date.now() - 2_000) },
        { createdAt: new Date(Date.now() - 3_000) },
        { createdAt: new Date(Date.now() - 4_000) },
        { createdAt: new Date(Date.now() - 5_000) },
      ]);

      // Correct password — still rejected, because the fast rate limit
      // fires before verifyPassword is ever reached.
      await expect(login('LWW-001', 'Waku2026!', {})).rejects.toMatchObject({
        status: 429,
        code: 'RATE_LIMITED',
      });
      expect(mockPrisma.session.create).not.toHaveBeenCalled();
    });

    it('tells the caller when the rate limit clears, based on the oldest counted failure', async () => {
      const passwordHash = await hashPassword('Waku2026!');
      mockPrisma.user.findFirst.mockResolvedValue(fakeUser({ passwordHash }));
      const oldestFailureAt = new Date(Date.now() - 5_000);
      mockPrisma.auditLog.findMany.mockResolvedValue([
        { createdAt: new Date(Date.now() - 1_000) },
        { createdAt: new Date(Date.now() - 2_000) },
        { createdAt: new Date(Date.now() - 3_000) },
        { createdAt: new Date(Date.now() - 4_000) },
        { createdAt: oldestFailureAt },
      ]);

      await expect(login('LWW-001', 'Waku2026!', {})).rejects.toMatchObject({
        status: 429,
        code: 'RATE_LIMITED',
        details: { retryAt: new Date(oldestFailureAt.getTime() + 15 * 60 * 1000).toISOString() },
      });
    });

    it('rejects with 423 while an active lockout window is still in effect', async () => {
      const passwordHash = await hashPassword('Waku2026!');
      mockPrisma.user.findFirst.mockResolvedValue(fakeUser({ passwordHash }));
      mockPrisma.auditLog.findFirst.mockResolvedValue({
        action: 'ACCOUNT_LOCKED',
        after: { lockedUntil: new Date(Date.now() + 60_000).toISOString() },
      });

      await expect(login('LWW-001', 'Waku2026!', {})).rejects.toMatchObject({
        status: 423,
        code: 'ACCOUNT_LOCKED',
      });
    });

    it('allows login once a past lockout has expired', async () => {
      const passwordHash = await hashPassword('Waku2026!');
      mockPrisma.user.findFirst.mockResolvedValue(fakeUser({ passwordHash }));
      mockPrisma.auditLog.findFirst.mockResolvedValue({
        action: 'ACCOUNT_LOCKED',
        after: { lockedUntil: new Date(Date.now() - 60_000).toISOString() }, // in the past
      });

      const result = await login('LWW-001', 'Waku2026!', {});
      expect(result.status).toBe('success');
    });

    it('locks the account on the 10th failure within the window and reports it distinctly from a plain wrong password', async () => {
      const passwordHash = await hashPassword('Waku2026!');
      mockPrisma.user.findFirst.mockResolvedValue(fakeUser({ passwordHash }));
      // The fast rate-limit check now queries via findMany (mocked to []
      // by beforeEach, safely under RATE_LIMIT_THRESHOLD) — only
      // maybeLockAccount's own two counts (failure count, prior-lockout
      // count for escalation) go through auditLog.count here.
      mockPrisma.auditLog.count.mockImplementation(({ where }: { where: { action: string } }) => {
        if (where.action === 'LOGIN_FAILURE') {
          return Promise.resolve(10);
        }
        return Promise.resolve(0);
      });

      await expect(login('LWW-001', 'wrong-password', {})).rejects.toMatchObject({
        status: 423,
        code: 'ACCOUNT_LOCKED',
      });
      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ action: 'ACCOUNT_LOCKED', entityId: 'user_1' }) }),
      );
    });
  });

  describe('TOTP for SYSTEM_ADMIN only (spec §3.1.1)', () => {
    it('does not require TOTP for a role that is not SYSTEM_ADMIN', async () => {
      const passwordHash = await hashPassword('Waku2026!');
      mockPrisma.user.findFirst.mockResolvedValue(
        fakeUser({ passwordHash, roles: [{ role: { key: 'CASHIER' } }] }),
      );
      const result = await login('LWW-001', 'Waku2026!', {});
      expect(result.status).toBe('success');
    });

    it('does not require TOTP for OWNER (deliberately excluded, 2026-08-22 — read-only role, lower blast radius)', async () => {
      const passwordHash = await hashPassword('Waku2026!');
      mockPrisma.user.findFirst.mockResolvedValue(
        fakeUser({ passwordHash, roles: [{ role: { key: 'OWNER' } }] }),
      );
      const result = await login('LWW-001', 'Waku2026!', {});
      expect(result.status).toBe('success');
    });

    it('returns totp_setup_required and persists a fresh secret on an unenrolled SYSTEM_ADMIN account, without issuing a session', async () => {
      const passwordHash = await hashPassword('Waku2026!');
      mockPrisma.user.findFirst.mockResolvedValue(
        fakeUser({ passwordHash, roles: [{ role: { key: 'SYSTEM_ADMIN' } }], totpSecret: null }),
      );

      const result = await login('LWW-001', 'Waku2026!', {});
      expect(result.status).toBe('totp_setup_required');
      if (result.status !== 'totp_setup_required') throw new Error('unreachable');
      expect(result.provisioningUri).toMatch(/^otpauth:\/\/totp\//);
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user_1' },
        data: { totpSecret: expect.any(String) },
      });
      expect(mockPrisma.session.create).not.toHaveBeenCalled();
    });

    it('requires a TOTP code once enrolled, and does not count a missing code as a failure', async () => {
      const passwordHash = await hashPassword('Waku2026!');
      const totpSecret = generateTotpSecret();
      mockPrisma.user.findFirst.mockResolvedValue(
        fakeUser({ passwordHash, roles: [{ role: { key: 'SYSTEM_ADMIN' } }], totpSecret }),
      );

      await expect(login('LWW-001', 'Waku2026!', {})).rejects.toMatchObject({
        status: 401,
        code: 'TOTP_REQUIRED',
      });
      expect(mockPrisma.auditLog.create).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ action: 'LOGIN_FAILURE' }) }),
      );
    });

    it('rejects an invalid TOTP code, and this DOES count toward lockout', async () => {
      const passwordHash = await hashPassword('Waku2026!');
      const totpSecret = generateTotpSecret();
      mockPrisma.user.findFirst.mockResolvedValue(
        fakeUser({ passwordHash, roles: [{ role: { key: 'SYSTEM_ADMIN' } }], totpSecret }),
      );

      await expect(login('LWW-001', 'Waku2026!', {}, '000000')).rejects.toMatchObject({
        status: 401,
        code: 'TOTP_INVALID',
      });
      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ action: 'LOGIN_FAILURE', actorId: 'user_1' }) }),
      );
    });

    it('completes login with a valid TOTP code', async () => {
      const passwordHash = await hashPassword('Waku2026!');
      const totpSecret = generateTotpSecret();
      mockPrisma.user.findFirst.mockResolvedValue(
        fakeUser({ passwordHash, roles: [{ role: { key: 'SYSTEM_ADMIN' } }], totpSecret }),
      );

      const code = new (await import('otpauth')).TOTP({ secret: totpSecret }).generate();
      expect(verifyTotpCode(totpSecret, code)).toBe(true); // sanity check on the test's own code

      const result = await login('LWW-001', 'Waku2026!', {}, code);
      expect(result.status).toBe('success');
    });
  });
});

describe('refresh', () => {
  it('rotates the refresh token and issues a new access token for a valid, unexpired session', async () => {
    mockPrisma.session.findFirst.mockResolvedValue({
      id: 'session_1',
      userId: 'user_1',
      refreshTokenHash: 'old-hash-placeholder',
      expiresAt: new Date(Date.now() + 1000 * 60 * 60),
    });

    const result = await refresh('some-refresh-token');
    expect(verifyAccessToken(result.accessToken)?.sub).toBe('user_1');
    expect(result.refreshToken).toMatch(/^[0-9a-f]{96}$/);
    expect(result.refreshToken).not.toBe('some-refresh-token');

    expect(mockPrisma.session.update).toHaveBeenCalledWith({
      where: { id: 'session_1' },
      data: {
        previousRefreshTokenHash: 'old-hash-placeholder',
        refreshTokenHash: expect.any(String),
      },
    });
  });

  it('rejects a token matching neither a current nor a previously-rotated hash', async () => {
    mockPrisma.session.findFirst.mockResolvedValue(null);
    await expect(refresh('unknown-token')).rejects.toMatchObject({ status: 401, code: 'SESSION_EXPIRED' });
    expect(mockPrisma.session.update).not.toHaveBeenCalled();
  });

  it('rejects an expired session even when the current hash matches', async () => {
    mockPrisma.session.findFirst.mockResolvedValue({
      id: 'session_1',
      userId: 'user_1',
      refreshTokenHash: 'old-hash-placeholder',
      expiresAt: new Date(Date.now() - 1000),
    });
    await expect(refresh('expired-token')).rejects.toMatchObject({ status: 401, code: 'SESSION_EXPIRED' });
  });

  it('detects replay of a rotated-out token, revokes the session, and audits it distinctly', async () => {
    mockPrisma.session.findFirst.mockImplementation(
      ({ where }: { where: { refreshTokenHash?: string; previousRefreshTokenHash?: string } }) => {
        if (where.refreshTokenHash) return Promise.resolve(null);
        if (where.previousRefreshTokenHash) {
          return Promise.resolve({ id: 'session_1', userId: 'user_1' });
        }
        return Promise.resolve(null);
      },
    );

    await expect(refresh('stolen-old-token', { ip: '1.2.3.4' })).rejects.toMatchObject({
      status: 401,
      code: 'SESSION_EXPIRED',
    });

    expect(mockPrisma.session.update).toHaveBeenCalledWith({
      where: { id: 'session_1' },
      data: { revokedAt: expect.any(Date) },
    });
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'REFRESH_TOKEN_REUSE_DETECTED',
          actorId: 'user_1',
          entityId: 'session_1',
        }),
      }),
    );
  });
});

describe('logout', () => {
  it('revokes the session matching the refresh token', async () => {
    await logout('some-refresh-token');
    expect(mockPrisma.session.updateMany).toHaveBeenCalledWith({
      where: { refreshTokenHash: expect.any(String), revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });
});

describe('getMe', () => {
  it('returns the user with roles and effective permissions', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(fakeUser());
    const user = await getMe('user_1');
    expect(user.roles).toEqual(['RESORT_MANAGER']);
    expect(user.permissions['booking:checkin']).toBe('ALL');
  });

  it('rejects a soft-deleted or inactive user', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(null);
    await expect(getMe('gone')).rejects.toMatchObject({ status: 401 });
  });
});

describe('sessions (spec §3.1.1 "sign out all other devices")', () => {
  it('lists only this user\'s active, unexpired sessions, never exposing token hashes', async () => {
    mockPrisma.session.findMany.mockResolvedValue([
      { id: 'session_1', ip: '1.2.3.4', userAgent: 'Chrome', createdAt: new Date(), expiresAt: new Date() },
    ]);
    const sessions = await listSessions('user_1');
    expect(sessions).toHaveLength(1);
    expect(mockPrisma.session.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user_1', revokedAt: null, deletedAt: null, expiresAt: { gt: expect.any(Date) } },
        select: { id: true, ip: true, userAgent: true, createdAt: true, expiresAt: true },
      }),
    );
  });

  it('revokes a session belonging to the caller and audits it', async () => {
    mockPrisma.session.findFirst.mockResolvedValue({ id: 'session_1', userId: 'user_1' });
    await revokeSession('user_1', 'session_1', { ip: '1.2.3.4' });
    expect(mockPrisma.session.update).toHaveBeenCalledWith({
      where: { id: 'session_1' },
      data: { revokedAt: expect.any(Date) },
    });
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'SESSION_REVOKED', actorId: 'user_1', entityId: 'session_1' }),
      }),
    );
  });

  it('refuses to revoke a session belonging to a different user', async () => {
    // The query itself is scoped by userId — a session owned by someone
    // else simply won't be found under this caller's id.
    mockPrisma.session.findFirst.mockResolvedValue(null);
    await expect(revokeSession('user_1', 'someone-elses-session', {})).rejects.toMatchObject({ status: 404 });
  });
});

describe('changePassword (forces mustChangePassword to resolve)', () => {
  it('rejects an incorrect current password', async () => {
    const passwordHash = await hashPassword('Waku2026!');
    mockPrisma.user.findFirst.mockResolvedValue(fakeUser({ passwordHash }));

    await expect(changePassword('user_1', 'wrong-current', 'NewPassword1')).rejects.toMatchObject({
      status: 401,
      code: 'INVALID_CREDENTIALS',
    });
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('updates the password hash and clears mustChangePassword on success', async () => {
    const passwordHash = await hashPassword('Waku2026!');
    mockPrisma.user.findFirst.mockResolvedValue(fakeUser({ passwordHash, mustChangePassword: true }));

    await changePassword('user_1', 'Waku2026!', 'NewPassword1');

    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user_1' },
      data: { passwordHash: expect.any(String), mustChangePassword: false },
    });
    // Never revokes other sessions — see service.ts's own comment on why
    // this differs from an admin-triggered reset.
    expect(mockPrisma.session.updateMany).not.toHaveBeenCalled();
  });
});
