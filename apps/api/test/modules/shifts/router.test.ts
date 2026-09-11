import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPrisma = {
  user: { findFirst: vi.fn(), findMany: vi.fn() },
  shift: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  auditLog: { create: vi.fn(), count: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
};

vi.mock('../../../src/lib/prisma.js', () => ({ prisma: mockPrisma }));

const { createApp } = await import('../../../src/app.js');
const { signAccessToken } = await import('../../../src/modules/auth/tokens.js');

function userWithRole(roleKey: string) {
  return {
    id: 'user_1',
    employeeCode: 'LWW-009',
    fullName: 'POC Housekeeping (Demo)',
    email: null,
    department: 'HOUSEKEEPING',
    isActive: true,
    mustChangePassword: false,
    deletedAt: null,
    roles: [{ role: { key: roleKey } }],
  };
}

function authCookie() {
  return [`lwwbr_access=${signAccessToken('user_1')}`];
}

function fakeShift(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'shift_1',
    userId: 'user_2',
    date: new Date('2026-09-20T00:00:00.000Z'),
    startTime: new Date('2026-09-20T06:00:00.000Z'),
    endTime: new Date('2026-09-20T14:00:00.000Z'),
    department: 'HOUSEKEEPING',
    isReliever: false,
    note: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    user: { id: 'user_2', fullName: 'Room Attendant (Demo)' },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.auditLog.findFirst.mockResolvedValue(null);
  mockPrisma.auditLog.count.mockResolvedValue(0);
  mockPrisma.auditLog.findMany.mockResolvedValue([]);
});

const CREATE_BODY = {
  userId: 'user_2',
  date: '2026-09-20T00:00:00.000Z',
  startTime: '2026-09-20T06:00:00.000Z',
  endTime: '2026-09-20T14:00:00.000Z',
  department: 'HOUSEKEEPING',
};

describe('POST /api/v1/shifts', () => {
  it.each(['SYSTEM_ADMIN', 'RESORT_MANAGER', 'POC_HOUSEKEEPING'])('allows %s to create a shift', async (roleKey) => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole(roleKey));
    mockPrisma.shift.create.mockResolvedValue(fakeShift());

    const res = await request(createApp()).post('/api/v1/shifts').set('Cookie', authCookie()).send(CREATE_BODY);

    expect(res.status).toBe(201);
    expect(res.body.shift.id).toBe('shift_1');
  });

  it('defaults isReliever to false when omitted', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('SYSTEM_ADMIN'));
    mockPrisma.shift.create.mockResolvedValue(fakeShift());

    await request(createApp()).post('/api/v1/shifts').set('Cookie', authCookie()).send(CREATE_BODY);

    expect(mockPrisma.shift.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ isReliever: false }) }),
    );
  });

  it('sets isReliever true when provided', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('SYSTEM_ADMIN'));
    mockPrisma.shift.create.mockResolvedValue(fakeShift({ isReliever: true }));

    const res = await request(createApp())
      .post('/api/v1/shifts')
      .set('Cookie', authCookie())
      .send({ ...CREATE_BODY, isReliever: true });

    expect(res.status).toBe(201);
    expect(mockPrisma.shift.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ isReliever: true }) }),
    );
  });

  it.each(['HOUSEKEEPING_STAFF', 'OWNER'])('refuses %s — shift:read does not include shift:manage', async (roleKey) => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole(roleKey));
    const res = await request(createApp()).post('/api/v1/shifts').set('Cookie', authCookie()).send(CREATE_BODY);
    expect(res.status).toBe(403);
  });
});

describe('GET /api/v1/shifts/assignable-users', () => {
  it('allows shift:manage to list assignable users — no user:read required', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('POC_HOUSEKEEPING'));
    mockPrisma.user.findMany.mockResolvedValue([
      { id: 'user_2', fullName: 'Room Attendant (Demo)', employeeCode: 'LWW-010', department: 'HOUSEKEEPING' },
    ]);

    const res = await request(createApp()).get('/api/v1/shifts/assignable-users').set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(1);
  });

  it('refuses a shift:read-only role', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('HOUSEKEEPING_STAFF'));
    const res = await request(createApp()).get('/api/v1/shifts/assignable-users').set('Cookie', authCookie());
    expect(res.status).toBe(403);
  });
});

describe('GET /api/v1/shifts', () => {
  it.each(['SYSTEM_ADMIN', 'HOUSEKEEPING_STAFF', 'OWNER'])('allows %s to view the roster (universal shift:read)', async (roleKey) => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole(roleKey));
    mockPrisma.shift.findMany.mockResolvedValue([fakeShift()]);
    const res = await request(createApp()).get('/api/v1/shifts').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.shifts).toHaveLength(1);
  });
});

describe('PATCH /api/v1/shifts/:id', () => {
  it('allows shift:manage to edit a shift', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('POC_HOUSEKEEPING'));
    mockPrisma.shift.findFirst.mockResolvedValue(fakeShift());
    mockPrisma.shift.update.mockResolvedValue(fakeShift({ isReliever: true }));

    const res = await request(createApp())
      .patch('/api/v1/shifts/shift_1')
      .set('Cookie', authCookie())
      .send({ isReliever: true });

    expect(res.status).toBe(200);
    expect(res.body.shift.isReliever).toBe(true);
  });

  it('404s for a shift that does not exist', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('SYSTEM_ADMIN'));
    mockPrisma.shift.findFirst.mockResolvedValue(null);
    const res = await request(createApp())
      .patch('/api/v1/shifts/missing')
      .set('Cookie', authCookie())
      .send({ isReliever: true });
    expect(res.status).toBe(404);
  });

  it('refuses a shift:read-only role', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('HOUSEKEEPING_STAFF'));
    const res = await request(createApp())
      .patch('/api/v1/shifts/shift_1')
      .set('Cookie', authCookie())
      .send({ isReliever: true });
    expect(res.status).toBe(403);
  });
});

// Client follow-up: a delete/cancel action so a mistaken roster entry
// can actually be corrected — soft-delete (deletedAt), not the
// hard-delete pattern MenuItem/AmenityItem use elsewhere.
describe('DELETE /api/v1/shifts/:id', () => {
  it('soft-deletes a shift (sets deletedAt via update, not a real .delete() call)', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('SYSTEM_ADMIN'));
    mockPrisma.shift.findFirst.mockResolvedValue(fakeShift());
    mockPrisma.shift.update.mockResolvedValue(fakeShift({ deletedAt: new Date() }));

    const res = await request(createApp()).delete('/api/v1/shifts/shift_1').set('Cookie', authCookie());

    expect(res.status).toBe(204);
    expect(mockPrisma.shift.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'shift_1' }, data: { deletedAt: expect.any(Date) } }),
    );
  });

  it('404s for a shift that does not exist', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('SYSTEM_ADMIN'));
    mockPrisma.shift.findFirst.mockResolvedValue(null);
    const res = await request(createApp()).delete('/api/v1/shifts/missing').set('Cookie', authCookie());
    expect(res.status).toBe(404);
  });

  it('refuses a shift:read-only role', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('HOUSEKEEPING_STAFF'));
    const res = await request(createApp()).delete('/api/v1/shifts/shift_1').set('Cookie', authCookie());
    expect(res.status).toBe(403);
    expect(mockPrisma.shift.update).not.toHaveBeenCalled();
  });
});
