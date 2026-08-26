import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPrisma = {
  user: { findFirst: vi.fn() },
  unit: { findMany: vi.fn() },
  unitStatusEvent: { findMany: vi.fn() },
  workOrder: { findMany: vi.fn() },
};

vi.mock('../../../src/lib/prisma.js', () => ({ prisma: mockPrisma }));

const mockGetSignedUrl = vi.fn();
vi.mock('../../../src/adapters/storage/index.js', () => ({
  getStorageAdapter: () => ({ getSignedUrl: mockGetSignedUrl }),
}));

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
  mockGetSignedUrl.mockImplementation((key: string) => Promise.resolve(`https://signed.example/${key}`));
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
      { id: 'unit_1', code: 'R01', name: 'Room 1', type: 'ROOM', createdAt: new Date('2026-08-01T00:00:00Z') },
      { id: 'unit_2', code: 'R02', name: 'Room 2', type: 'ROOM', createdAt: new Date('2026-08-01T00:00:00Z') },
      { id: 'unit_3', code: 'POOL', name: 'Pool', type: 'COMMON_AREA', createdAt: new Date('2026-08-01T00:00:00Z') },
    ]);
    // R01 becomes OCCUPIED on the 24th; R02/Pool never transition (stay
    // at the VACANT_DIRTY column default with no logged event).
    mockPrisma.unitStatusEvent.findMany.mockResolvedValue([
      { unitId: 'unit_1', toStatus: 'OCCUPIED', createdAt: new Date('2026-08-24T10:00:00+08:00') },
    ]);

    const res = await request(createApp())
      .get('/api/v1/reports/occupancy?from=2026-08-24&to=2026-08-25')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.report.rows).toHaveLength(6); // 3 units x 2 days
    const day24R01 = res.body.report.rows.find((r: { date: string; unitCode: string }) => r.date === '2026-08-24' && r.unitCode === 'R01');
    expect(day24R01.status).toBe('OCCUPIED');
    expect(day24R01.group).toBe('Rooms & Cottages');
    const day24R02 = res.body.report.rows.find((r: { date: string; unitCode: string }) => r.date === '2026-08-24' && r.unitCode === 'R02');
    expect(day24R02.status).toBe('VACANT_DIRTY');
    const day24Pool = res.body.report.rows.find((r: { date: string; unitCode: string }) => r.date === '2026-08-24' && r.unitCode === 'POOL');
    expect(day24Pool.group).toBe('Common areas');
    expect(res.body.report.summary.byDay).toEqual([
      { date: '2026-08-24', occupiedCount: 1, totalUnits: 3, occupancyRate: 1 / 3 },
      { date: '2026-08-25', occupiedCount: 1, totalUnits: 3, occupancyRate: 1 / 3 },
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

  // Unlike occupancy (refused outright, no department axis at all), this
  // report's data genuinely IS housekeeping's own — a same-department
  // holder sees it normally.
  it('allows the housekeeping report for a DEPARTMENT-scoped holder in Housekeeping', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('POC_HOUSEKEEPING', { department: 'HOUSEKEEPING' }));
    mockPrisma.unitStatusEvent.findMany.mockResolvedValue([]);

    const res = await request(createApp())
      .get('/api/v1/reports/housekeeping?from=2026-08-24&to=2026-08-25')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
  });

  // A DEPARTMENT-scoped holder from a different department has no
  // housekeeping data of their own — refused, same as occupancy but
  // department-aware rather than blanket.
  it('refuses the housekeeping report for a DEPARTMENT-scoped holder outside Housekeeping', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('POC_MAINTENANCE', { department: 'MAINTENANCE' }));
    const res = await request(createApp())
      .get('/api/v1/reports/housekeeping?from=2026-08-24&to=2026-08-25')
      .set('Cookie', authCookie());
    expect(res.status).toBe(403);
  });

  it('builds the housekeeping report: rooms cleaned per attendant and average clean time', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.unitStatusEvent.findMany.mockResolvedValue([
      // unit_1: a complete 30-minute clean by Attendant A, finished inside range.
      {
        unitId: 'unit_1',
        toStatus: 'CLEANING',
        actorId: 'user_a',
        createdAt: new Date('2026-08-24T09:00:00+08:00'),
        unit: { code: 'R01', name: 'Room 1' },
        actor: { fullName: 'Attendant A' },
      },
      {
        unitId: 'unit_1',
        toStatus: 'CLEANED',
        actorId: 'user_a',
        createdAt: new Date('2026-08-24T09:30:00+08:00'),
        unit: { code: 'R01', name: 'Room 1' },
        actor: { fullName: 'Attendant A' },
      },
      // unit_2: a CLEANED event with no preceding CLEANING start observed
      // (e.g. a forced correction) — skipped, no clean cycle to measure.
      {
        unitId: 'unit_2',
        toStatus: 'CLEANED',
        actorId: 'user_b',
        createdAt: new Date('2026-08-24T10:00:00+08:00'),
        unit: { code: 'R02', name: 'Room 2' },
        actor: { fullName: 'Attendant B' },
      },
      // unit_3: a 20-minute clean by Attendant A again, finished inside range.
      {
        unitId: 'unit_3',
        toStatus: 'CLEANING',
        actorId: 'user_a',
        createdAt: new Date('2026-08-25T08:00:00+08:00'),
        unit: { code: 'R03', name: 'Room 3' },
        actor: { fullName: 'Attendant A' },
      },
      {
        unitId: 'unit_3',
        toStatus: 'CLEANED',
        actorId: 'user_a',
        createdAt: new Date('2026-08-25T08:20:00+08:00'),
        unit: { code: 'R03', name: 'Room 3' },
        actor: { fullName: 'Attendant A' },
      },
    ]);

    const res = await request(createApp())
      .get('/api/v1/reports/housekeeping?from=2026-08-24&to=2026-08-25')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    const { summary, rows } = res.body.report;
    expect(rows).toHaveLength(2);
    expect(summary.totalRoomsCleaned).toBe(2);
    expect(summary.avgCleanTimeMinutes).toBe(25); // (30 + 20) / 2
    expect(summary.byAttendant).toEqual([
      { attendantId: 'user_a', attendantName: 'Attendant A', roomsCleaned: 2, avgCleanTimeMinutes: 25 },
    ]);
    expect(rows.find((r: { unitCode: string }) => r.unitCode === 'R01')).toMatchObject({
      attendantName: 'Attendant A',
      cleanTimeMinutes: 30,
    });
  });

  it('excludes a clean cycle that started before the range and has not finished by "to"', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.unitStatusEvent.findMany.mockResolvedValue([
      {
        unitId: 'unit_1',
        toStatus: 'CLEANING',
        actorId: 'user_a',
        createdAt: new Date('2026-08-24T09:00:00+08:00'),
        unit: { code: 'R01', name: 'Room 1' },
        actor: { fullName: 'Attendant A' },
      },
    ]);

    const res = await request(createApp())
      .get('/api/v1/reports/housekeeping?from=2026-08-24&to=2026-08-24')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.report.rows).toEqual([]);
    expect(res.body.report.summary.totalRoomsCleaned).toBe(0);
    expect(res.body.report.summary.avgCleanTimeMinutes).toBeNull();
  });

  // Same reasoning as housekeeping's own department-scope test: unlike
  // occupancy, this report's data genuinely belongs to one department.
  it('allows the maintenance log for a DEPARTMENT-scoped holder in Maintenance', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('POC_MAINTENANCE', { department: 'MAINTENANCE' }));
    mockPrisma.workOrder.findMany.mockResolvedValue([]);

    const res = await request(createApp())
      .get('/api/v1/reports/maintenance-log?from=2026-08-24&to=2026-08-25')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
  });

  it('refuses the maintenance log for a DEPARTMENT-scoped holder outside Maintenance', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('POC_HOUSEKEEPING', { department: 'HOUSEKEEPING' }));
    const res = await request(createApp())
      .get('/api/v1/reports/maintenance-log?from=2026-08-24&to=2026-08-25')
      .set('Cookie', authCookie());
    expect(res.status).toBe(403);
  });

  it('builds the maintenance log: filters to type MAINTENANCE, groups by day, and returns signed issue/completion photo URLs', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.workOrder.findMany.mockResolvedValue([
      {
        id: 'wo_1',
        referenceNo: 'WO-001',
        title: 'Leaking faucet',
        status: 'VERIFIED',
        unit: { code: 'R01', name: 'Room 1' },
        createdAt: new Date('2026-08-24T09:00:00+08:00'),
        photos: [
          { id: 'photo_issue', kind: 'ISSUE', caption: 'Before', file: { storageKey: 'wo1/issue.jpg' } },
          { id: 'photo_done', kind: 'COMPLETION', caption: 'After', file: { storageKey: 'wo1/done.jpg' } },
        ],
      },
      {
        id: 'wo_2',
        referenceNo: 'WO-002',
        title: 'AC not cooling',
        status: 'IN_PROGRESS',
        unit: { code: 'R02', name: 'Room 2' },
        createdAt: new Date('2026-08-25T09:00:00+08:00'),
        photos: [{ id: 'photo_issue2', kind: 'ISSUE', caption: null, file: { storageKey: 'wo2/issue.jpg' } }],
      },
    ]);

    const res = await request(createApp())
      .get('/api/v1/reports/maintenance-log?from=2026-08-24&to=2026-08-25')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    const { summary, rows } = res.body.report;
    expect(mockPrisma.workOrder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ type: 'MAINTENANCE' }) }),
    );
    expect(summary.totalTickets).toBe(2);
    expect(summary.byDay).toEqual([
      { date: '2026-08-24', ticketCount: 1 },
      { date: '2026-08-25', ticketCount: 1 },
    ]);
    const wo1 = rows.find((r: { id: string }) => r.id === 'wo_1');
    expect(wo1.issuePhotos).toEqual([{ id: 'photo_issue', url: 'https://signed.example/wo1/issue.jpg', caption: 'Before' }]);
    expect(wo1.completionPhotos).toEqual([{ id: 'photo_done', url: 'https://signed.example/wo1/done.jpg', caption: 'After' }]);
    expect(wo1.issuePhotoUrls).toBe('https://signed.example/wo1/issue.jpg');
    expect(mockGetSignedUrl).toHaveBeenCalledWith('wo1/issue.jpg', 3600);
    const wo2 = rows.find((r: { id: string }) => r.id === 'wo_2');
    expect(wo2.completionPhotos).toEqual([]);
    expect(wo2.completionPhotoUrls).toBe('');
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

  it('exports the housekeeping report as CSV', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.unitStatusEvent.findMany.mockResolvedValue([
      {
        unitId: 'unit_1',
        toStatus: 'CLEANING',
        actorId: 'user_a',
        createdAt: new Date('2026-08-24T09:00:00+08:00'),
        unit: { code: 'R01', name: 'Room 1' },
        actor: { fullName: 'Attendant A' },
      },
      {
        unitId: 'unit_1',
        toStatus: 'CLEANED',
        actorId: 'user_a',
        createdAt: new Date('2026-08-24T09:30:00+08:00'),
        unit: { code: 'R01', name: 'Room 1' },
        actor: { fullName: 'Attendant A' },
      },
    ]);

    const res = await request(createApp())
      .get('/api/v1/reports/housekeeping/export?from=2026-08-24&to=2026-08-25&format=csv')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text).toContain('Unit,Unit name,Attendant');
    expect(res.text).toContain('R01,Room 1,Attendant A');
  });

  it('exports the maintenance log as CSV, carrying authenticated photo URLs', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.workOrder.findMany.mockResolvedValue([
      {
        id: 'wo_1',
        referenceNo: 'WO-001',
        title: 'Leaking faucet',
        status: 'VERIFIED',
        unit: { code: 'R01', name: 'Room 1' },
        createdAt: new Date('2026-08-24T09:00:00+08:00'),
        photos: [{ id: 'photo_issue', kind: 'ISSUE', caption: null, file: { storageKey: 'wo1/issue.jpg' } }],
      },
    ]);

    const res = await request(createApp())
      .get('/api/v1/reports/maintenance-log/export?from=2026-08-24&to=2026-08-25&format=csv')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text).toContain('Date,Reference,Title');
    expect(res.text).toContain('https://signed.example/wo1/issue.jpg');
  });
});
