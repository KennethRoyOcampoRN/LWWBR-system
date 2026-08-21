import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hashPassword } from '../../../src/modules/auth/passwords.js';

const mockPrisma = {
  user: { findFirst: vi.fn(), update: vi.fn() },
  session: { create: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
  auditLog: { create: vi.fn() },
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
