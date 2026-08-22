import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hashPassword } from '../../../src/modules/auth/passwords.js';

const mockPrisma = {
  user: { findFirst: vi.fn(), update: vi.fn() },
  session: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  auditLog: { create: vi.fn(), count: vi.fn(), findFirst: vi.fn() },
};

vi.mock('../../../src/lib/prisma.js', () => ({ prisma: mockPrisma }));

const { createApp } = await import('../../../src/app.js');

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
  // Defaults so login flows in these tests aren't rate-limited/locked —
  // the throttle logic itself is covered directly in service.test.ts.
  mockPrisma.auditLog.findFirst.mockResolvedValue(null);
  mockPrisma.auditLog.count.mockResolvedValue(0);
});

describe('POST /api/v1/auth/login', () => {
  it('sets httpOnly access and refresh cookies on success', async () => {
    const passwordHash = await hashPassword('Waku2026!');
    mockPrisma.user.findFirst.mockResolvedValue(fakeUser({ passwordHash }));

    const res = await request(createApp())
      .post('/api/v1/auth/login')
      .send({ employeeCode: 'LWW-001', password: 'Waku2026!' });

    expect(res.status).toBe(200);
    expect(res.body.user.employeeCode).toBe('LWW-001');
    const cookies = res.headers['set-cookie'] as unknown as string[];
    expect(cookies.some((c) => c.startsWith('lwwbr_access=') && c.includes('HttpOnly'))).toBe(true);
    expect(cookies.some((c) => c.startsWith('lwwbr_refresh=') && c.includes('HttpOnly'))).toBe(true);
  });

  it('returns 401 with the spec §4.8 error shape on bad credentials', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(null);

    const res = await request(createApp())
      .post('/api/v1/auth/login')
      .send({ employeeCode: 'nope', password: 'nope' });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: { code: 'INVALID_CREDENTIALS', message: expect.any(String) } });
  });

  it('returns 422 when the body fails validation', async () => {
    const res = await request(createApp()).post('/api/v1/auth/login').send({ employeeCode: '' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /api/v1/auth/refresh', () => {
  it('rotates both cookies on a successful refresh', async () => {
    const passwordHash = await hashPassword('Waku2026!');
    mockPrisma.user.findFirst.mockResolvedValue(fakeUser({ passwordHash }));

    let createdSession: { id: string; refreshTokenHash: string; expiresAt: Date } | undefined;
    mockPrisma.session.create.mockImplementation(
      ({ data }: { data: { refreshTokenHash: string; expiresAt: Date } }) => {
        createdSession = { id: 'session_1', ...data };
        return Promise.resolve(createdSession);
      },
    );

    const agent = request.agent(createApp());
    await agent.post('/api/v1/auth/login').send({ employeeCode: 'LWW-001', password: 'Waku2026!' });

    mockPrisma.session.findFirst.mockImplementation(
      ({ where }: { where: { refreshTokenHash?: string } }) => {
        if (where.refreshTokenHash === createdSession?.refreshTokenHash) {
          return Promise.resolve(createdSession);
        }
        return Promise.resolve(null);
      },
    );

    const res = await agent.post('/api/v1/auth/refresh');
    expect(res.status).toBe(200);
    const cookies = res.headers['set-cookie'] as unknown as string[];
    expect(cookies.some((c) => c.startsWith('lwwbr_access=') && c.includes('HttpOnly'))).toBe(true);
    expect(cookies.some((c) => c.startsWith('lwwbr_refresh=') && c.includes('HttpOnly'))).toBe(true);
    expect(mockPrisma.session.update).toHaveBeenCalledOnce();
  });
});

describe('GET /api/v1/auth/me', () => {
  it('returns 401 with no session cookie', async () => {
    const res = await request(createApp()).get('/api/v1/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('returns the authenticated user after logging in', async () => {
    const passwordHash = await hashPassword('Waku2026!');
    mockPrisma.user.findFirst.mockResolvedValue(fakeUser({ passwordHash }));

    const agent = request.agent(createApp());
    await agent.post('/api/v1/auth/login').send({ employeeCode: 'LWW-001', password: 'Waku2026!' });

    const res = await agent.get('/api/v1/auth/me');
    expect(res.status).toBe(200);
    expect(res.body.user.roles).toEqual(['RESORT_MANAGER']);
  });
});

describe('POST /api/v1/auth/logout', () => {
  it('clears cookies and returns 204 even with no session', async () => {
    const res = await request(createApp()).post('/api/v1/auth/logout');
    expect(res.status).toBe(204);
    const cookies = res.headers['set-cookie'] as unknown as string[];
    expect(cookies.some((c) => c.startsWith('lwwbr_access=;'))).toBe(true);
  });
});

describe('POST /api/v1/auth/change-password', () => {
  it('requires authentication', async () => {
    const res = await request(createApp())
      .post('/api/v1/auth/change-password')
      .send({ currentPassword: 'x', newPassword: 'NewPassword1' });
    expect(res.status).toBe(401);
  });

  it('rejects an incorrect current password without changing the hash', async () => {
    const passwordHash = await hashPassword('Waku2026!');
    mockPrisma.user.findFirst.mockResolvedValue(fakeUser({ passwordHash }));

    const agent = request.agent(createApp());
    await agent.post('/api/v1/auth/login').send({ employeeCode: 'LWW-001', password: 'Waku2026!' });

    const res = await agent.post('/api/v1/auth/change-password').send({
      currentPassword: 'wrong-current',
      newPassword: 'NewPassword1',
    });
    expect(res.status).toBe(401);
    expect(mockPrisma.user.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ mustChangePassword: false }) }),
    );
  });

  it('changes the password and clears mustChangePassword on success', async () => {
    const passwordHash = await hashPassword('Waku2026!');
    mockPrisma.user.findFirst.mockResolvedValue(fakeUser({ passwordHash }));

    const agent = request.agent(createApp());
    await agent.post('/api/v1/auth/login').send({ employeeCode: 'LWW-001', password: 'Waku2026!' });

    const res = await agent.post('/api/v1/auth/change-password').send({
      currentPassword: 'Waku2026!',
      newPassword: 'NewPassword1',
    });
    expect(res.status).toBe(204);
    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user_1' },
      data: { passwordHash: expect.any(String), mustChangePassword: false },
    });
  });

  it('returns 422 when the new password is too short', async () => {
    const passwordHash = await hashPassword('Waku2026!');
    mockPrisma.user.findFirst.mockResolvedValue(fakeUser({ passwordHash }));

    const agent = request.agent(createApp());
    await agent.post('/api/v1/auth/login').send({ employeeCode: 'LWW-001', password: 'Waku2026!' });

    const res = await agent.post('/api/v1/auth/change-password').send({
      currentPassword: 'Waku2026!',
      newPassword: 'short',
    });
    expect(res.status).toBe(422);
  });
});

describe('GET /api/v1/auth/sessions and POST /api/v1/auth/sessions/:id/revoke', () => {
  it('requires authentication', async () => {
    const res = await request(createApp()).get('/api/v1/auth/sessions');
    expect(res.status).toBe(401);
  });

  it('lists the logged-in user\'s sessions and can revoke one of them', async () => {
    const passwordHash = await hashPassword('Waku2026!');
    mockPrisma.user.findFirst.mockResolvedValue(fakeUser({ passwordHash }));
    mockPrisma.session.findMany.mockResolvedValue([
      { id: 'session_1', ip: '1.2.3.4', userAgent: 'Chrome', createdAt: new Date(), expiresAt: new Date() },
    ]);

    const agent = request.agent(createApp());
    await agent.post('/api/v1/auth/login').send({ employeeCode: 'LWW-001', password: 'Waku2026!' });

    const listRes = await agent.get('/api/v1/auth/sessions');
    expect(listRes.status).toBe(200);
    expect(listRes.body.sessions).toHaveLength(1);

    mockPrisma.session.findFirst.mockResolvedValue({ id: 'session_1', userId: 'user_1' });
    const revokeRes = await agent.post('/api/v1/auth/sessions/session_1/revoke');
    expect(revokeRes.status).toBe(204);
    expect(mockPrisma.session.update).toHaveBeenCalledWith({
      where: { id: 'session_1' },
      data: { revokedAt: expect.any(Date) },
    });
  });
});
