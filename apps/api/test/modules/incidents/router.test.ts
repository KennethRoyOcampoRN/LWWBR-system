import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPrisma = {
  user: { findFirst: vi.fn(), findMany: vi.fn() },
  referenceSequence: { upsert: vi.fn() },
  incident: { create: vi.fn(), findMany: vi.fn() },
  notification: { create: vi.fn(), createMany: vi.fn() },
  auditLog: { create: vi.fn(), count: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
};

vi.mock('../../../src/lib/prisma.js', () => ({ prisma: mockPrisma }));

const mockRealtimeEmit = vi.fn();
vi.mock('../../../src/adapters/realtime/index.js', () => ({
  getRealtimeAdapter: () => ({ emit: mockRealtimeEmit }),
}));

const { createApp } = await import('../../../src/app.js');
const { signAccessToken } = await import('../../../src/modules/auth/tokens.js');

function userWithRole(roleKey: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'user_1',
    employeeCode: 'LWW-020',
    fullName: 'Resort Staff (Demo)',
    email: null,
    department: 'GROUNDS_SAFETY',
    isActive: true,
    mustChangePassword: false,
    deletedAt: null,
    roles: [{ role: { key: roleKey } }],
    ...overrides,
  };
}

function authCookie() {
  return [`lwwbr_access=${signAccessToken('user_1')}`];
}

function fakeIncident(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'incident_1',
    referenceNo: 'IC-260826-0001',
    type: 'SAFETY',
    severity: 'HIGH',
    description: 'Loose railing near the pool deck',
    location: 'Pool',
    involvedUserId: null,
    bookingId: null,
    reportedById: 'user_1',
    status: 'OPEN',
    resolution: null,
    resolvedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.auditLog.findFirst.mockResolvedValue(null);
  mockPrisma.auditLog.count.mockResolvedValue(0);
  mockPrisma.auditLog.findMany.mockResolvedValue([]);
  mockPrisma.referenceSequence.upsert.mockResolvedValue({ scope: 'IC-260826', seq: 1 });
  mockPrisma.notification.create.mockResolvedValue({ id: 'notif_1', createdAt: new Date(), type: 'SAFETY_INCIDENT' });
  mockPrisma.user.findMany.mockResolvedValue([]);
  mockRealtimeEmit.mockResolvedValue(undefined);
});

describe('POST /api/v1/incidents', () => {
  // No 403 test here: incident:create is seeded ALL-scope on every
  // single role (spec §8.3's "report an incident button" appears on
  // multiple role dashboards) — there is no role in this app that
  // actually lacks it, so a negative-permission test would have no real
  // role to exercise it with. Confirmed against rolePermissions.ts.
  it('creates an incident and returns 201, broadly held permission (RESORT_STAFF)', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_STAFF'));
    mockPrisma.incident.create.mockResolvedValue(fakeIncident({ type: 'GUEST_COMPLAINT' }));

    const res = await request(createApp())
      .post('/api/v1/incidents')
      .set('Cookie', authCookie())
      .send({ type: 'GUEST_COMPLAINT', severity: 'LOW', description: 'Guest unhappy with room view' });

    expect(res.status).toBe(201);
    expect(res.body.incident.referenceNo).toBe('IC-260826-0001');
    expect(mockPrisma.incident.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: 'GUEST_COMPLAINT', severity: 'LOW', reportedById: 'user_1' }),
      }),
    );
  });

  // Spec §8.3: "Push immediately only for: ... a safety incident." Real
  // trigger point — see incidents/service.ts's own comment for why
  // SAFETY specifically, no severity gate.
  it('notifies every OWNER immediately when a SAFETY incident is created', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_STAFF'));
    mockPrisma.incident.create.mockResolvedValue(fakeIncident());
    mockPrisma.user.findMany.mockResolvedValue([{ id: 'owner_1' }, { id: 'owner_2' }]);

    const res = await request(createApp())
      .post('/api/v1/incidents')
      .set('Cookie', authCookie())
      .send({ type: 'SAFETY', severity: 'HIGH', description: 'Loose railing near the pool deck' });

    expect(res.status).toBe(201);
    expect(mockPrisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ roles: { some: { deletedAt: null, role: { key: 'OWNER' } } } }),
      }),
    );
    expect(mockPrisma.notification.create).toHaveBeenCalledTimes(2);
    expect(mockPrisma.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: 'owner_1', type: 'SAFETY_INCIDENT', entityType: 'Incident', entityId: 'incident_1' }),
      }),
    );
  });

  it('does not notify anyone for a non-SAFETY incident type', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_STAFF'));
    mockPrisma.incident.create.mockResolvedValue(fakeIncident({ type: 'SECURITY' }));

    const res = await request(createApp())
      .post('/api/v1/incidents')
      .set('Cookie', authCookie())
      .send({ type: 'SECURITY', severity: 'HIGH', description: 'Unattended bag at the entrance' });

    expect(res.status).toBe(201);
    expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.notification.create).not.toHaveBeenCalled();
  });
});

describe('GET /api/v1/incidents', () => {
  it('requires incident:read, distinct from incident:create', async () => {
    // RESORT_STAFF holds incident:create but not incident:read.
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_STAFF'));
    const res = await request(createApp()).get('/api/v1/incidents').set('Cookie', authCookie());
    expect(res.status).toBe(403);
  });

  it('lists incidents for an oversight role', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER', { department: 'MANAGEMENT' }));
    mockPrisma.incident.findMany.mockResolvedValue([fakeIncident()]);

    const res = await request(createApp()).get('/api/v1/incidents').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.incidents).toHaveLength(1);
    expect(res.body.incidents[0].referenceNo).toBe('IC-260826-0001');
  });

  it('filters by status when provided', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER', { department: 'MANAGEMENT' }));
    mockPrisma.incident.findMany.mockResolvedValue([]);

    await request(createApp()).get('/api/v1/incidents?status=RESOLVED').set('Cookie', authCookie());

    expect(mockPrisma.incident.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: 'RESOLVED' }) }),
    );
  });
});
