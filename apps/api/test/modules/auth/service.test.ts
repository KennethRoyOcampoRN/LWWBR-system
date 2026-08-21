import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hashPassword } from '../../../src/modules/auth/passwords.js';
import { verifyAccessToken } from '../../../src/modules/auth/tokens.js';

const mockPrisma = {
  user: { findFirst: vi.fn(), update: vi.fn() },
  session: { create: vi.fn(), findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  auditLog: { create: vi.fn() },
};

// Mocked so these tests exercise the real password/token logic (argon2,
// JWT signing) against a fake persistence layer instead of a real
// database — no network dependency, and it runs the same everywhere.
vi.mock('../../../src/lib/prisma.js', () => ({ prisma: mockPrisma }));

const { login, refresh, logout, getMe } = await import('../../../src/modules/auth/service.js');

function fakeUser(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'user_1',
    employeeCode: 'LWW-001',
    fullName: 'Resort Manager (Demo)',
    email: null,
    department: 'MANAGEMENT',
    isActive: true,
    mustChangePassword: true,
    deletedAt: null,
    roles: [{ role: { key: 'RESORT_MANAGER' } }],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('login', () => {
  it('succeeds with the correct password, creates a session, and audits success', async () => {
    const passwordHash = await hashPassword('Waku2026!');
    mockPrisma.user.findFirst.mockResolvedValue(fakeUser({ passwordHash }));

    const result = await login('LWW-001', 'Waku2026!', { ip: '127.0.0.1', userAgent: 'vitest' });

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
    expect(user.permissions['booking:create']).toBe('ALL');
  });

  it('rejects a soft-deleted or inactive user', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(null);
    await expect(getMe('gone')).rejects.toMatchObject({ status: 401 });
  });
});
