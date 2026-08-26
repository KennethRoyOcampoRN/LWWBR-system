import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPrisma = {
  user: { findFirst: vi.fn() },
  unit: { findMany: vi.fn() },
  unitStatusEvent: { findMany: vi.fn() },
  workOrder: { findMany: vi.fn() },
};

vi.mock('../../../src/lib/prisma.js', () => ({ prisma: mockPrisma }));

const { createApp } = await import('../../../src/app.js');
const { signAccessToken } = await import('../../../src/modules/auth/tokens.js');

function userWithRole(roleKey: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'user_1',
    employeeCode: 'LWW-001',
    fullName: 'Resort Manager (Demo)',
    email: null,
    department: 'MANAGEMENT',
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/v1/reports/:key', () => {
  it('requires report:view', async () => {
    // RESTAURANT_STAFF holds no report:* key at all.
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESTAURANT_STAFF'));
    const res = await request(createApp())
      .get('/api/v1/reports/occupancy?from=2026-08-24&to=2026-08-25')
      .set('Cookie', authCookie());
    expect(res.status).toBe(403);
  });

  it('rejects an unknown report key', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    const res = await request(createApp())
      .get('/api/v1/reports/does-not-exist?from=2026-08-24&to=2026-08-25')
      .set('Cookie', authCookie());
    expect(res.status).toBe(422); // zod rejects an unrecognized enum value at the router
  });

  it('rejects from after to', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    const res = await request(createApp())
      .get('/api/v1/reports/occupancy?from=2026-08-26&to=2026-08-24')
      .set('Cookie', authCookie());
    expect(res.status).toBe(422);
  });

  // A DEPARTMENT-scoped report:view holder has no department axis on
  // Unit to be scoped to — see service.ts's buildOccupancyReport comment.
  it('refuses occupancy for a DEPARTMENT-scoped report:view holder', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('POC_HOUSEKEEPING', { department: 'HOUSEKEEPING' }));
    const res = await request(createApp())
      .get('/api/v1/reports/occupancy?from=2026-08-24&to=2026-08-25')
      .set('Cookie', authCookie());
    expect(res.status).toBe(403);
  });

  it('builds the occupancy report by day and by unit', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.unit.findMany.mockResolvedValue([
      { id: 'unit_1', code: 'R01', name: 'Room 1', createdAt: new Date('2026-08-01T00:00:00Z') },
      { id: 'unit_2', code: 'R02', name: 'Room 2', createdAt: new Date('2026-08-01T00:00:00Z') },
    ]);
    // R01 becomes OCCUPIED on the 24th; R02 never transitions (stays the
    // VACANT_DIRTY column default with no logged event).
    mockPrisma.unitStatusEvent.findMany.mockResolvedValue([
      { unitId: 'unit_1', toStatus: 'OCCUPIED', createdAt: new Date('2026-08-24T10:00:00+08:00') },
    ]);

    const res = await request(createApp())
      .get('/api/v1/reports/occupancy?from=2026-08-24&to=2026-08-25')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.report.rows).toHaveLength(4); // 2 units x 2 days
    const day24R01 = res.body.report.rows.find((r: { date: string; unitCode: string }) => r.date === '2026-08-24' && r.unitCode === 'R01');
    expect(day24R01.status).toBe('OCCUPIED');
    const day24R02 = res.body.report.rows.find((r: { date: string; unitCode: string }) => r.date === '2026-08-24' && r.unitCode === 'R02');
    expect(day24R02.status).toBe('VACANT_DIRTY');
    expect(res.body.report.summary.byDay).toEqual([
      { date: '2026-08-24', occupiedCount: 1, totalUnits: 2, occupancyRate: 0.5 },
      { date: '2026-08-25', occupiedCount: 1, totalUnits: 2, occupancyRate: 0.5 },
    ]);
  });

  it('builds the work-orders report with volume, breakdowns, SLA breaches, and time-to-close', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    const now = Date.now();
    mockPrisma.workOrder.findMany.mockResolvedValue([
      {
        id: 'wo_1',
        referenceNo: 'WO-001',
        type: 'MAINTENANCE',
        department: 'MAINTENANCE',
        status: 'VERIFIED',
        unit: { code: 'R01', name: 'Room 1' },
        createdAt: new Date(now - 120 * 60_000),
        dueAt: new Date(now - 90 * 60_000),
        completedAt: new Date(now - 30 * 60_000),
        verifiedAt: new Date(now - 20 * 60_000), // closed after dueAt -> breached; 100min to close
      },
      {
        id: 'wo_2',
        referenceNo: 'WO-002',
        type: 'HOUSEKEEPING',
        department: 'HOUSEKEEPING',
        status: 'IN_PROGRESS',
        unit: { code: 'R01', name: 'Room 1' },
        createdAt: new Date(now - 60 * 60_000),
        dueAt: new Date(now - 10 * 60_000), // still open past due -> breached
        completedAt: null,
        verifiedAt: null,
      },
      {
        id: 'wo_3',
        referenceNo: 'WO-003',
        type: 'GENERAL',
        department: 'FRONT_OFFICE',
        status: 'CANCELLED',
        unit: null,
        createdAt: new Date(now - 30 * 60_000),
        dueAt: new Date(now - 5 * 60_000), // past due, but CANCELLED never breaches
        completedAt: null,
        verifiedAt: null,
      },
    ]);

    const res = await request(createApp())
      .get('/api/v1/reports/work-orders?from=2026-08-24&to=2026-08-25')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    const { summary, rows } = res.body.report;
    expect(summary.totalVolume).toBe(3);
    expect(summary.slaBreachedCount).toBe(2);
    expect(summary.avgTimeToCloseMinutes).toBe(100);
    expect(summary.byType).toEqual(
      expect.arrayContaining([
        { type: 'MAINTENANCE', count: 1 },
        { type: 'HOUSEKEEPING', count: 1 },
        { type: 'GENERAL', count: 1 },
      ]),
    );
    expect(summary.topRecurringUnits[0]).toEqual({ unitCode: 'R01', unitName: 'Room 1', count: 2 });
    expect(rows.find((r: { id: string }) => r.id === 'wo_3').slaBreached).toBe(false);
  });

  // POC_MAINTENANCE holds report:view at DEPARTMENT scope — the
  // work-orders report DOES have a department axis, unlike occupancy, so
  // it's forced to their own department rather than refused outright.
  it('forces the work-orders report to the caller\'s own department for a DEPARTMENT-scoped holder', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('POC_MAINTENANCE', { department: 'MAINTENANCE' }));
    mockPrisma.workOrder.findMany.mockResolvedValue([]);

    const res = await request(createApp())
      .get('/api/v1/reports/work-orders?from=2026-08-24&to=2026-08-25&department=RESTAURANT')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(mockPrisma.workOrder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ department: 'MAINTENANCE' }) }),
    );
  });
});

describe('GET /api/v1/reports/:key/export', () => {
  it('requires report:export, distinct from report:view', async () => {
    // POC_HOUSEKEEPING holds report:view but not report:export.
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('POC_HOUSEKEEPING', { department: 'HOUSEKEEPING' }));
    const res = await request(createApp())
      .get('/api/v1/reports/work-orders/export?from=2026-08-24&to=2026-08-25&format=csv')
      .set('Cookie', authCookie());
    expect(res.status).toBe(403);
  });

  it('exports the work-orders report as CSV', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.workOrder.findMany.mockResolvedValue([
      {
        id: 'wo_1',
        referenceNo: 'WO-001',
        type: 'MAINTENANCE',
        department: 'MAINTENANCE',
        status: 'OPEN',
        unit: { code: 'R01', name: 'Room 1' },
        createdAt: new Date('2026-08-24T10:00:00Z'),
        dueAt: null,
        completedAt: null,
        verifiedAt: null,
      },
    ]);

    const res = await request(createApp())
      .get('/api/v1/reports/work-orders/export?from=2026-08-24&to=2026-08-25&format=csv')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text).toContain('Reference,Type,Department');
    expect(res.text).toContain('WO-001,MAINTENANCE,MAINTENANCE');
  });
});
