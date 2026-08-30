import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Set before any module that calls getEnv() is imported below — these
// are read lazily (module-level cache, populated on first call), so as
// long as this runs before the dynamic `await import('../../../src/app.js')`
// further down, sendOwnerDigest sees them as configured.
process.env.RESEND_API_KEY = 'test-resend-key';
process.env.OWNER_DIGEST_FROM_EMAIL = 'digest@example.com';
process.env.WEB_BASE_URL = 'https://example.com';

const mockPrisma = {
  user: { findFirst: vi.fn(), findMany: vi.fn() },
  unit: { findMany: vi.fn() },
  unitStatusEvent: { findMany: vi.fn(), count: vi.fn() },
  workOrder: { findMany: vi.fn() },
  incident: { count: vi.fn() },
  notification: { create: vi.fn(), findFirst: vi.fn() },
  setting: { findUnique: vi.fn() },
  auditLog: { create: vi.fn(), count: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
};

vi.mock('../../../src/lib/prisma.js', () => ({ prisma: mockPrisma }));

const mockRealtimeEmit = vi.fn();
vi.mock('../../../src/adapters/realtime/index.js', () => ({
  getRealtimeAdapter: () => ({ emit: mockRealtimeEmit }),
}));

const mockEmailsSend = vi.fn();
vi.mock('resend', () => ({
  Resend: vi.fn().mockImplementation(() => ({ emails: { send: mockEmailsSend } })),
}));

const { createApp } = await import('../../../src/app.js');

function fakeUrgentBreachedWorkOrder(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'wo_1',
    referenceNo: 'WO-260826-0001',
    title: 'Generator down',
    department: 'MAINTENANCE',
    priority: 'URGENT',
    dueAt: new Date(Date.now() - 60 * 60 * 1000),
    unit: { id: 'unit_1', code: 'GEN', name: 'Generator Room' },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.auditLog.findFirst.mockResolvedValue(null);
  mockPrisma.auditLog.count.mockResolvedValue(0);
  mockPrisma.auditLog.findMany.mockResolvedValue([]);
  mockPrisma.unit.findMany.mockResolvedValue([]);
  mockPrisma.unitStatusEvent.findMany.mockResolvedValue([]);
  mockPrisma.unitStatusEvent.count.mockResolvedValue(0);
  mockPrisma.workOrder.findMany.mockResolvedValue([]);
  mockPrisma.incident.count.mockResolvedValue(0);
  mockPrisma.notification.findFirst.mockResolvedValue(null);
  mockPrisma.notification.create.mockResolvedValue({ id: 'notif_1', createdAt: new Date(), type: 'WORKORDER_SLA_BREACHED' });
  mockPrisma.setting.findUnique.mockResolvedValue(null);
  mockPrisma.user.findMany.mockResolvedValue([]);
  mockRealtimeEmit.mockResolvedValue(undefined);
  mockEmailsSend.mockResolvedValue({ data: { id: 'email_1' }, error: null });
});

describe('POST /api/v1/jobs/exception-alerts', () => {
  it('rejects a missing job secret', async () => {
    const res = await request(createApp()).post('/api/v1/jobs/exception-alerts');
    expect(res.status).toBe(401);
  });

  it('rejects a wrong job secret', async () => {
    const res = await request(createApp()).post('/api/v1/jobs/exception-alerts').set('x-job-secret', 'wrong');
    expect(res.status).toBe(401);
  });

  // Spec §8.3's SLA-breach exception-alert trigger.
  it('alerts every OWNER when an urgent work order is past its SLA', async () => {
    mockPrisma.workOrder.findMany.mockResolvedValue([fakeUrgentBreachedWorkOrder()]);
    mockPrisma.user.findMany.mockResolvedValue([{ id: 'owner_1' }, { id: 'owner_2' }]);

    const res = await request(createApp())
      .post('/api/v1/jobs/exception-alerts')
      .set('x-job-secret', process.env.JOB_SECRET as string);

    expect(res.status).toBe(200);
    expect(res.body.alertedCount).toBe(1);
    expect(mockPrisma.notification.create).toHaveBeenCalledTimes(2);
    expect(mockPrisma.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'owner_1',
          type: 'WORKORDER_SLA_BREACHED',
          entityType: 'WorkOrder',
          entityId: 'wo_1',
        }),
      }),
    );
  });

  // Dedup: without this, the same breached ticket would re-alert on
  // every 15-minute sweep run.
  it('does not re-alert a ticket that already has a WORKORDER_SLA_BREACHED notification', async () => {
    mockPrisma.workOrder.findMany.mockResolvedValue([fakeUrgentBreachedWorkOrder()]);
    mockPrisma.user.findMany.mockResolvedValue([{ id: 'owner_1' }]);
    mockPrisma.notification.findFirst.mockResolvedValue({ id: 'notif_existing' });

    const res = await request(createApp())
      .post('/api/v1/jobs/exception-alerts')
      .set('x-job-secret', process.env.JOB_SECRET as string);

    expect(res.status).toBe(200);
    expect(res.body.alertedCount).toBe(0);
    expect(mockPrisma.notification.create).not.toHaveBeenCalled();
  });

  it('does nothing when there are no urgent SLA-breached work orders', async () => {
    mockPrisma.workOrder.findMany.mockResolvedValue([]);

    const res = await request(createApp())
      .post('/api/v1/jobs/exception-alerts')
      .set('x-job-secret', process.env.JOB_SECRET as string);

    expect(res.status).toBe(200);
    expect(res.body.alertedCount).toBe(0);
    expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/jobs/owner-digest', () => {
  it('rejects a missing job secret', async () => {
    const res = await request(createApp()).post('/api/v1/jobs/owner-digest');
    expect(res.status).toBe(401);
  });

  it('rejects a wrong job secret', async () => {
    const res = await request(createApp()).post('/api/v1/jobs/owner-digest').set('x-job-secret', 'wrong');
    expect(res.status).toBe(401);
  });

  it('sends the digest via resend to every OWNER with an email set, given the correct secret', async () => {
    mockPrisma.user.findMany.mockResolvedValue([{ email: 'owner@example.com' }]);
    mockPrisma.unit.findMany.mockResolvedValue([
      { id: 'unit_1', code: 'R01', name: 'Room 1', type: 'ROOM', createdAt: new Date('2026-08-01T00:00:00Z') },
    ]);
    mockPrisma.unitStatusEvent.findMany.mockResolvedValue([]);
    mockPrisma.unitStatusEvent.count.mockResolvedValue(3);
    mockPrisma.incident.count.mockResolvedValue(1);
    mockPrisma.workOrder.findMany.mockResolvedValue([fakeUrgentBreachedWorkOrder()]);

    const res = await request(createApp())
      .post('/api/v1/jobs/owner-digest')
      .set('x-job-secret', process.env.JOB_SECRET as string);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ channel: 'email', recipients: 1, sent: 1 });
    expect(mockEmailsSend).toHaveBeenCalledTimes(1);
    const sendCall = mockEmailsSend.mock.calls[0]![0];
    expect(sendCall.from).toBe('digest@example.com');
    expect(sendCall.to).toEqual(['owner@example.com']);
    expect(sendCall.text).toContain('Arrivals: 3');
    expect(sendCall.text).toContain('Incidents: 1');
    expect(sendCall.text).toContain('not tracked');
    expect(sendCall.html).toContain('https://example.com/work-orders?id=wo_1');
  });

  it('skips sending, reporting why, when no OWNER has an email address set', async () => {
    mockPrisma.user.findMany.mockResolvedValue([]);

    const res = await request(createApp())
      .post('/api/v1/jobs/owner-digest')
      .set('x-job-secret', process.env.JOB_SECRET as string);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      channel: 'email',
      recipients: 0,
      sent: 0,
      skippedReason: 'No active OWNER-role user has an email address set.',
    });
    expect(mockEmailsSend).not.toHaveBeenCalled();
  });

  it('skips sending when the channel Setting is not "email"', async () => {
    mockPrisma.setting.findUnique.mockResolvedValue({ value: 'sms' });

    const res = await request(createApp())
      .post('/api/v1/jobs/owner-digest')
      .set('x-job-secret', process.env.JOB_SECRET as string);

    expect(res.status).toBe(200);
    expect(res.body.channel).toBe('sms');
    expect(res.body.sent).toBe(0);
    expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
    expect(mockEmailsSend).not.toHaveBeenCalled();
  });
});
