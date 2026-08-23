import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPrisma = {
  user: { findFirst: vi.fn() },
  fileObject: { findMany: vi.fn() },
  setting: { findUnique: vi.fn() },
  referenceSequence: { upsert: vi.fn() },
  workOrder: { create: vi.fn(), findMany: vi.fn(), findFirst: vi.fn() },
  auditLog: { create: vi.fn(), count: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
};

vi.mock('../../../src/lib/prisma.js', () => ({ prisma: mockPrisma }));

const mockRealtimeEmit = vi.fn();
vi.mock('../../../src/adapters/realtime/index.js', () => ({
  getRealtimeAdapter: () => ({ emit: mockRealtimeEmit }),
}));

const mockGetSignedUrl = vi.fn();
vi.mock('../../../src/adapters/storage/index.js', () => ({
  getStorageAdapter: () => ({ getSignedUrl: mockGetSignedUrl }),
}));

const { createApp } = await import('../../../src/app.js');
const { signAccessToken } = await import('../../../src/modules/auth/tokens.js');

function userWithRole(roleKey: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'user_1',
    employeeCode: 'LWW-011',
    fullName: 'POC Maintenance (Demo)',
    email: null,
    department: 'MAINTENANCE',
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

function fakeWorkOrder(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'wo_1',
    referenceNo: 'WO-260823-0001',
    type: 'MAINTENANCE',
    title: 'Leaking faucet in R01',
    description: null,
    priority: 'NORMAL',
    status: 'OPEN',
    version: 0,
    unitId: null,
    bookingId: null,
    department: 'MAINTENANCE',
    createdById: 'user_1',
    assignedToId: null,
    assignedById: null,
    dueAt: null,
    startedAt: null,
    completedAt: null,
    verifiedById: null,
    verifiedAt: null,
    attemptNo: 1,
    isRecurring: false,
    recurrenceRule: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    photos: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.auditLog.findFirst.mockResolvedValue(null);
  mockPrisma.auditLog.count.mockResolvedValue(0);
  mockPrisma.auditLog.findMany.mockResolvedValue([]);
  mockRealtimeEmit.mockResolvedValue(undefined);
  mockPrisma.setting.findUnique.mockResolvedValue(null); // fall back to shared defaults
  mockPrisma.referenceSequence.upsert.mockResolvedValue({ scope: 'WO-260823', seq: 1 });
});

describe('POST /api/v1/work-orders — spec §7.2.1 mandatory photo evidence', () => {
  it('rejects creating a MAINTENANCE ticket with no photos at all (422 PHOTO_REQUIRED)', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('POC_MAINTENANCE'));

    const res = await request(createApp())
      .post('/api/v1/work-orders')
      .set('Cookie', authCookie())
      .send({ type: 'MAINTENANCE', title: 'Leaking faucet in R01', department: 'MAINTENANCE' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PHOTO_REQUIRED');
    expect(res.body.error.details).toEqual({ kind: 'ISSUE' });
    expect(mockPrisma.workOrder.create).not.toHaveBeenCalled();
  });

  it('rejects creating a MAINTENANCE ticket with only a PROGRESS photo attached — the kind must specifically be ISSUE', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('POC_MAINTENANCE'));

    const res = await request(createApp())
      .post('/api/v1/work-orders')
      .set('Cookie', authCookie())
      .send({
        type: 'MAINTENANCE',
        title: 'Leaking faucet in R01',
        department: 'MAINTENANCE',
        photos: [{ fileId: 'file_1', kind: 'PROGRESS' }],
      });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PHOTO_REQUIRED');
    expect(mockPrisma.workOrder.create).not.toHaveBeenCalled();
  });

  it('creates a MAINTENANCE ticket when an ISSUE photo is attached', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('POC_MAINTENANCE'));
    mockPrisma.fileObject.findMany.mockResolvedValue([{ id: 'file_1' }]);
    mockPrisma.workOrder.create.mockResolvedValue(
      fakeWorkOrder({ photos: [{ id: 'photo_1', fileId: 'file_1', kind: 'ISSUE' }] }),
    );

    const res = await request(createApp())
      .post('/api/v1/work-orders')
      .set('Cookie', authCookie())
      .send({
        type: 'MAINTENANCE',
        title: 'Leaking faucet in R01',
        department: 'MAINTENANCE',
        photos: [{ fileId: 'file_1', kind: 'ISSUE' }],
      });

    expect(res.status).toBe(201);
    expect(res.body.workOrder.referenceNo).toBe('WO-260823-0001');
    expect(mockPrisma.workOrder.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'MAINTENANCE',
          createdById: 'user_1',
          photos: { create: [expect.objectContaining({ fileId: 'file_1', kind: 'ISSUE', uploadedById: 'user_1' })] },
        }),
      }),
    );
    expect(mockRealtimeEmit).toHaveBeenCalledWith(
      'property',
      'workorder.created',
      expect.objectContaining({ entityId: 'wo_1', actorId: 'user_1' }),
    );
  });

  it('creates a HOUSEKEEPING ticket with no photos — not required for that type', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('POC_HOUSEKEEPING'));
    mockPrisma.workOrder.create.mockResolvedValue(fakeWorkOrder({ type: 'HOUSEKEEPING', department: 'HOUSEKEEPING' }));

    const res = await request(createApp())
      .post('/api/v1/work-orders')
      .set('Cookie', authCookie())
      .send({ type: 'HOUSEKEEPING', title: 'Turn down service', department: 'HOUSEKEEPING' });

    expect(res.status).toBe(201);
    expect(mockPrisma.workOrder.create).toHaveBeenCalled();
  });

  it('rejects a referenced photo fileId that does not exist (422)', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('POC_MAINTENANCE'));
    mockPrisma.fileObject.findMany.mockResolvedValue([]); // the fileId doesn't resolve to anything

    const res = await request(createApp())
      .post('/api/v1/work-orders')
      .set('Cookie', authCookie())
      .send({
        type: 'MAINTENANCE',
        title: 'Leaking faucet in R01',
        department: 'MAINTENANCE',
        photos: [{ fileId: 'does_not_exist', kind: 'ISSUE' }],
      });

    expect(res.status).toBe(422);
    expect(mockPrisma.workOrder.create).not.toHaveBeenCalled();
  });

  it('does not fail creation when the realtime broadcast itself fails', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('POC_HOUSEKEEPING'));
    mockPrisma.workOrder.create.mockResolvedValue(fakeWorkOrder({ type: 'HOUSEKEEPING', department: 'HOUSEKEEPING' }));
    mockRealtimeEmit.mockRejectedValue(new Error('Supabase Realtime unreachable'));

    const res = await request(createApp())
      .post('/api/v1/work-orders')
      .set('Cookie', authCookie())
      .send({ type: 'HOUSEKEEPING', title: 'Turn down service', department: 'HOUSEKEEPING' });

    expect(res.status).toBe(201);
  });

  it('requires authentication', async () => {
    const res = await request(createApp())
      .post('/api/v1/work-orders')
      .send({ type: 'GENERAL', title: 'Something', department: 'RESTAURANT' });

    expect(res.status).toBe(401);
  });

  it('every seeded role holds workorder:create — spec §8.1: "every role" gets the report-an-issue button, including OWNER (resolved ambiguity, report-only)', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('OWNER', { department: 'MANAGEMENT' }));
    mockPrisma.workOrder.create.mockResolvedValue(fakeWorkOrder({ type: 'GENERAL', department: 'MANAGEMENT' }));

    const res = await request(createApp())
      .post('/api/v1/work-orders')
      .set('Cookie', authCookie())
      .send({ type: 'GENERAL', title: 'Something', department: 'MANAGEMENT' });

    expect(res.status).toBe(201);
  });
});

describe('GET /api/v1/work-orders — read scoping', () => {
  it('a plain workorder:read holder (no read_all) only sees their own tickets', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESTAURANT_STAFF', { department: 'RESTAURANT' }));
    mockPrisma.workOrder.findMany.mockResolvedValue([]);

    const res = await request(createApp()).get('/api/v1/work-orders').set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(mockPrisma.workOrder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ createdById: 'user_1' }, { assignedToId: 'user_1' }],
        }),
      }),
    );
  });

  it('a DEPARTMENT-scoped workorder:read_all holder only sees their department', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('POC_HOUSEKEEPING', { department: 'HOUSEKEEPING' }));
    mockPrisma.workOrder.findMany.mockResolvedValue([]);

    const res = await request(createApp()).get('/api/v1/work-orders').set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(mockPrisma.workOrder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ department: 'HOUSEKEEPING' }) }),
    );
  });

  it('an ALL-scoped workorder:read_all holder (SYSTEM_ADMIN) sees everything — no OR/department filter added', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('SYSTEM_ADMIN', { department: 'MANAGEMENT' }));
    mockPrisma.workOrder.findMany.mockResolvedValue([]);

    const res = await request(createApp()).get('/api/v1/work-orders').set('Cookie', authCookie());

    expect(res.status).toBe(200);
    const whereArg = mockPrisma.workOrder.findMany.mock.calls[0]?.[0]?.where;
    expect(whereArg.OR).toBeUndefined();
    expect(whereArg.department).toBeUndefined();
  });
});

describe('GET /api/v1/work-orders/:id', () => {
  it('returns 404 for an unknown work order', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('SYSTEM_ADMIN', { department: 'MANAGEMENT' }));
    mockPrisma.workOrder.findFirst.mockResolvedValue(null);

    const res = await request(createApp()).get('/api/v1/work-orders/wo_1').set('Cookie', authCookie());
    expect(res.status).toBe(404);
  });

  it('returns 403 when the caller has no read_all and did not create/get assigned the ticket', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESTAURANT_STAFF', { department: 'RESTAURANT' }));
    mockPrisma.workOrder.findFirst.mockResolvedValue(
      fakeWorkOrder({ createdById: 'someone_else', assignedToId: null, department: 'MAINTENANCE' }),
    );

    const res = await request(createApp()).get('/api/v1/work-orders/wo_1').set('Cookie', authCookie());
    expect(res.status).toBe(403);
  });

  it('returns the ticket with signed photo URLs for a visible caller', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('POC_MAINTENANCE', { department: 'MAINTENANCE' }));
    mockPrisma.workOrder.findFirst.mockResolvedValue(
      fakeWorkOrder({
        department: 'MAINTENANCE',
        photos: [
          {
            id: 'photo_1',
            kind: 'ISSUE',
            caption: null,
            capturedAt: new Date(),
            attemptNo: 1,
            file: { storageKey: 'uploads/abc.jpg' },
          },
        ],
      }),
    );
    mockGetSignedUrl.mockResolvedValue('https://signed.example/abc.jpg');

    const res = await request(createApp()).get('/api/v1/work-orders/wo_1').set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.workOrder.photos[0].url).toBe('https://signed.example/abc.jpg');
  });
});
