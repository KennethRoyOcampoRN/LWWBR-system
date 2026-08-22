import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPrisma = {
  user: { findFirst: vi.fn() },
  unitType: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  unit: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  unitStatusEvent: { findMany: vi.fn(), create: vi.fn() },
  auditLog: { create: vi.fn(), count: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
};

vi.mock('../../../src/lib/prisma.js', () => ({ prisma: mockPrisma }));

const { createApp } = await import('../../../src/app.js');
const { signAccessToken } = await import('../../../src/modules/auth/tokens.js');

function userWithRole(roleKey: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'user_1',
    employeeCode: 'LWW-008',
    fullName: 'POC Housekeeping (Demo)',
    email: null,
    department: 'HOUSEKEEPING',
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

function fakeUnit(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'unit_1',
    code: '101',
    name: 'Room 101',
    unitTypeId: 'type_1',
    type: 'ROOM',
    capacity: 2,
    floor: '1',
    status: 'CLEANED',
    version: 3,
    notes: null,
    isActive: true,
    sortOrder: 0,
    deletedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.auditLog.findFirst.mockResolvedValue(null);
  mockPrisma.auditLog.count.mockResolvedValue(0);
  mockPrisma.auditLog.findMany.mockResolvedValue([]);
});

describe('GET /api/v1/units and /unit-types', () => {
  it('requires unit:read', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESTAURANT_STAFF'));
    const res = await request(createApp()).get('/api/v1/units').set('Cookie', authCookie());
    expect(res.status).toBe(403);
  });

  it('lists units for a caller with unit:read', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('POC_HOUSEKEEPING'));
    mockPrisma.unit.findMany.mockResolvedValue([fakeUnit()]);

    const res = await request(createApp()).get('/api/v1/units').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.units).toHaveLength(1);
    expect(res.body.units[0].status).toBe('CLEANED');
  });

  it('serializes UnitType Decimal fields as plain numbers', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('POC_HOUSEKEEPING'));
    mockPrisma.unitType.findMany.mockResolvedValue([
      {
        id: 'type_1',
        name: 'Standard Room',
        description: null,
        defaultCapacity: 2,
        baseRate: { toString: () => '1500.00' },
        dayTourRate: null,
        extraPersonRate: { toString: () => '200.00' },
        colorHex: null,
        isActive: true,
        sortOrder: 0,
      },
    ]);

    const res = await request(createApp()).get('/api/v1/unit-types').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.unitTypes[0].baseRate).toBe(1500);
    expect(res.body.unitTypes[0].dayTourRate).toBeNull();
    expect(res.body.unitTypes[0].extraPersonRate).toBe(200);
  });
});

describe('POST /api/v1/units/:id/status', () => {
  it('allows a POC Housekeeping caller to move CLEANED -> INSPECTED (workorder:verify)', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('POC_HOUSEKEEPING'));
    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnit({ status: 'CLEANED', version: 3 }));
    mockPrisma.unit.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(createApp())
      .post('/api/v1/units/unit_1/status')
      .set('Cookie', authCookie())
      .send({ toStatus: 'INSPECTED', version: 3 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'unit_1', status: 'INSPECTED', version: 4 });
    expect(mockPrisma.unit.updateMany).toHaveBeenCalledWith({
      where: { id: 'unit_1', version: 3 },
      data: { status: 'INSPECTED', version: { increment: 1 } },
    });
    expect(mockPrisma.unitStatusEvent.create).toHaveBeenCalledWith({
      data: { unitId: 'unit_1', fromStatus: 'CLEANED', toStatus: 'INSPECTED', actorId: 'user_1', note: undefined },
    });
  });

  it('rejects a room attendant (unit:update_status only) trying to do the QC step', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('HOUSEKEEPING_STAFF'));
    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnit({ status: 'CLEANED', version: 3 }));

    const res = await request(createApp())
      .post('/api/v1/units/unit_1/status')
      .set('Cookie', authCookie())
      .send({ toStatus: 'INSPECTED', version: 3 });

    expect(res.status).toBe(403);
    expect(mockPrisma.unit.updateMany).not.toHaveBeenCalled();
  });

  it('lets a room attendant do their own allowed step, CLEANING -> CLEANED', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('HOUSEKEEPING_STAFF'));
    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnit({ status: 'CLEANING', version: 1 }));
    mockPrisma.unit.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(createApp())
      .post('/api/v1/units/unit_1/status')
      .set('Cookie', authCookie())
      .send({ toStatus: 'CLEANED', version: 1 });

    expect(res.status).toBe(200);
  });

  it('rejects skipping a step in the cycle with 422 INVALID_TRANSITION', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('SYSTEM_ADMIN'));
    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnit({ status: 'VACANT_DIRTY', version: 0 }));

    const res = await request(createApp())
      .post('/api/v1/units/unit_1/status')
      .set('Cookie', authCookie())
      .send({ toStatus: 'CLEANED', version: 0 });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVALID_TRANSITION');
  });

  it('rejects the automatic-only INSPECTED -> READY transition even for an admin', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('SYSTEM_ADMIN'));
    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnit({ status: 'INSPECTED', version: 5 }));

    const res = await request(createApp())
      .post('/api/v1/units/unit_1/status')
      .set('Cookie', authCookie())
      .send({ toStatus: 'READY', version: 5 });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVALID_TRANSITION');
    expect(mockPrisma.unit.updateMany).not.toHaveBeenCalled();
  });

  it('returns 409 on a stale version (concurrent edit)', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('HOUSEKEEPING_STAFF'));
    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnit({ status: 'CLEANING', version: 5 }));
    mockPrisma.unit.updateMany.mockResolvedValue({ count: 0 });

    const res = await request(createApp())
      .post('/api/v1/units/unit_1/status')
      .set('Cookie', authCookie())
      .send({ toStatus: 'CLEANED', version: 1 });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('VERSION_CONFLICT');
  });

  it('returns 404 for an unknown unit', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('SYSTEM_ADMIN'));
    mockPrisma.unit.findFirst.mockResolvedValue(null);

    const res = await request(createApp())
      .post('/api/v1/units/does_not_exist/status')
      .set('Cookie', authCookie())
      .send({ toStatus: 'CLEANING', version: 0 });

    expect(res.status).toBe(404);
  });
});

describe('GET /api/v1/units/:id/timeline', () => {
  it('returns the unit status event history', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('POC_HOUSEKEEPING'));
    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnit());
    mockPrisma.unitStatusEvent.findMany.mockResolvedValue([
      { id: 'event_1', fromStatus: 'CLEANING', toStatus: 'CLEANED', createdAt: new Date(), note: null },
    ]);

    const res = await request(createApp()).get('/api/v1/units/unit_1/timeline').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
  });
});
