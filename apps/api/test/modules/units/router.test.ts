import { TZDate } from '@date-fns/tz';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPrisma = {
  user: { findFirst: vi.fn() },
  unitType: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  unit: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), delete: vi.fn() },
  unitStatusEvent: { findMany: vi.fn(), create: vi.fn(), count: vi.fn() },
  bookingUnit: { count: vi.fn() },
  workOrder: { findMany: vi.fn(), count: vi.fn() },
  amenityRequest: { count: vi.fn(), findMany: vi.fn() },
  fnbOrder: { count: vi.fn() },
  inspection: { count: vi.fn() },
  setting: { findUnique: vi.fn() },
  remittanceRequest: { findMany: vi.fn() },
  quotationRequest: { findMany: vi.fn() },
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
  mockPrisma.workOrder.findMany.mockResolvedValue([]);
  mockPrisma.workOrder.count.mockResolvedValue(0);
  mockPrisma.unitStatusEvent.count.mockResolvedValue(0);
  mockPrisma.fnbOrder.count.mockResolvedValue(0);
  mockPrisma.amenityRequest.findMany.mockResolvedValue([]);
  mockPrisma.setting.findUnique.mockResolvedValue(null);
  mockPrisma.remittanceRequest.findMany.mockResolvedValue([]);
  mockPrisma.quotationRequest.findMany.mockResolvedValue([]);
  mockRealtimeEmit.mockResolvedValue(undefined);
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
    mockPrisma.unitStatusEvent.findMany.mockResolvedValue([]);

    const res = await request(createApp()).get('/api/v1/units').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.units).toHaveLength(1);
    expect(res.body.units[0].status).toBe('CLEANED');
    expect(res.body.units[0].latestNote).toBeNull();
    // Real-world caching gap found live 2026-08-23 while investigating a
    // report of a stale unit status persisting in the UI: every /api/v1
    // response now sets Cache-Control: no-store so a browser can never
    // legitimately serve a cached read of live operational state.
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('surfaces latestNote from any status-change panel, only while it is still attached to the latest event', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('POC_HOUSEKEEPING'));
    mockPrisma.unit.findMany.mockResolvedValue([fakeUnit()]);
    mockPrisma.unitStatusEvent.findMany.mockResolvedValue([
      { unitId: 'unit_1', note: 'staff forgot to mark this cleaned yesterday' },
    ]);

    const res = await request(createApp()).get('/api/v1/units').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.units[0].latestNote).toBe('staff forgot to mark this cleaned yesterday');
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

// Real gap found live-testing, 2026-08-25: there was no UI to add, edit,
// or deactivate a unit at all, despite these routes already existing —
// only the frontend was missing. Adding coverage for the routes
// themselves alongside the new UI.
describe('POST /api/v1/units', () => {
  it('requires unit:manage, not just unit:read', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('HOUSEKEEPING_STAFF'));
    const res = await request(createApp())
      .post('/api/v1/units')
      .set('Cookie', authCookie())
      .send({ code: 'R21', name: 'Room 21', unitTypeId: 'type_1', type: 'ROOM' });
    expect(res.status).toBe(403);
  });

  it('rejects an unknown unitTypeId', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.unitType.findFirst.mockResolvedValue(null);
    const res = await request(createApp())
      .post('/api/v1/units')
      .set('Cookie', authCookie())
      .send({ code: 'R21', name: 'Room 21', unitTypeId: 'type_1', type: 'ROOM' });
    expect(res.status).toBe(422);
    expect(mockPrisma.unit.create).not.toHaveBeenCalled();
  });

  it('rejects a code already in use', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.unitType.findFirst.mockResolvedValue({ id: 'type_1', defaultCapacity: 2 });
    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnit({ code: 'R21' }));
    const res = await request(createApp())
      .post('/api/v1/units')
      .set('Cookie', authCookie())
      .send({ code: 'R21', name: 'Room 21', unitTypeId: 'type_1', type: 'ROOM' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('UNIT_CODE_TAKEN');
  });

  it('creates a unit, defaulting capacity from the unit type when not given', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.unitType.findFirst.mockResolvedValue({ id: 'type_1', defaultCapacity: 4 });
    mockPrisma.unit.findFirst.mockResolvedValue(null);
    mockPrisma.unit.create.mockResolvedValue(fakeUnit({ code: 'R21', name: 'Room 21', capacity: 4 }));

    const res = await request(createApp())
      .post('/api/v1/units')
      .set('Cookie', authCookie())
      .send({ code: 'R21', name: 'Room 21', unitTypeId: 'type_1', type: 'ROOM' });

    expect(res.status).toBe(201);
    expect(mockPrisma.unit.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ code: 'R21', name: 'Room 21', type: 'ROOM', capacity: 4 }) }),
    );
  });

  // Client decision, 2026-08-25: choosing the type is the form's first
  // field, and every UNIT_KIND_KEYS value must reach the service intact
  // — including COMMON_AREA/FACILITY, not just ROOM/COTTAGE.
  it.each(['ROOM', 'COTTAGE', 'COMMON_AREA', 'FACILITY'])('accepts %s as a unit type', async (type) => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.unitType.findFirst.mockResolvedValue({ id: 'type_1', defaultCapacity: 1 });
    mockPrisma.unit.findFirst.mockResolvedValue(null);
    mockPrisma.unit.create.mockResolvedValue(fakeUnit({ type }));

    const res = await request(createApp())
      .post('/api/v1/units')
      .set('Cookie', authCookie())
      .send({ code: 'X01', name: 'Test unit', unitTypeId: 'type_1', type });

    expect(res.status).toBe(201);
  });
});

describe('PATCH /api/v1/units/:id', () => {
  it('requires unit:manage', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('HOUSEKEEPING_STAFF'));
    const res = await request(createApp()).patch('/api/v1/units/unit_1').set('Cookie', authCookie()).send({ name: 'New name' });
    expect(res.status).toBe(403);
  });

  it('returns 404 for an unknown unit', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.unit.findFirst.mockResolvedValue(null);
    const res = await request(createApp()).patch('/api/v1/units/does_not_exist').set('Cookie', authCookie()).send({ name: 'New name' });
    expect(res.status).toBe(404);
  });

  it('edits a unit\'s own details', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnit());
    mockPrisma.unit.update.mockResolvedValue(fakeUnit({ name: 'Room 101 Deluxe', capacity: 3 }));

    const res = await request(createApp())
      .patch('/api/v1/units/unit_1')
      .set('Cookie', authCookie())
      .send({ name: 'Room 101 Deluxe', capacity: 3 });

    expect(res.status).toBe(200);
    expect(res.body.unit.name).toBe('Room 101 Deluxe');
    expect(mockPrisma.unit.update).toHaveBeenCalledWith({
      where: { id: 'unit_1' },
      data: { name: 'Room 101 Deluxe', capacity: 3 },
    });
  });

  // Soft-delete/deactivate, per the client's explicit request — same
  // isActive-toggle pattern as AmenityItem/MenuItem, no hard delete.
  it('deactivates a unit via isActive', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnit({ isActive: true }));
    mockPrisma.unit.update.mockResolvedValue(fakeUnit({ isActive: false }));

    const res = await request(createApp()).patch('/api/v1/units/unit_1').set('Cookie', authCookie()).send({ isActive: false });

    expect(res.status).toBe(200);
    expect(res.body.unit.isActive).toBe(false);
    expect(mockPrisma.unit.update).toHaveBeenCalledWith({ where: { id: 'unit_1' }, data: { isActive: false } });
  });
});

// Client decision, 2026-08-25: a real delete, but only for a unit with
// zero real history ("I made a wrong room by mistake"). A unit that's
// actually been used keeps Deactivate as the correct tool.
describe('DELETE /api/v1/units/:id', () => {
  it('requires unit:manage', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('HOUSEKEEPING_STAFF'));
    const res = await request(createApp()).delete('/api/v1/units/unit_1').set('Cookie', authCookie());
    expect(res.status).toBe(403);
    expect(mockPrisma.unit.delete).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown unit', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.unit.findFirst.mockResolvedValue(null);
    const res = await request(createApp()).delete('/api/v1/units/does_not_exist').set('Cookie', authCookie());
    expect(res.status).toBe(404);
  });

  it('refuses to delete a still-active unit', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnit({ isActive: true }));
    const res = await request(createApp()).delete('/api/v1/units/unit_1').set('Cookie', authCookie());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('UNIT_STILL_ACTIVE');
    expect(mockPrisma.unit.delete).not.toHaveBeenCalled();
  });

  it.each(['unitStatusEvent', 'bookingUnit', 'workOrder', 'amenityRequest', 'fnbOrder', 'inspection'] as const)(
    'refuses to delete an inactive unit that has %s history',
    async (relation) => {
      mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
      mockPrisma.unit.findFirst.mockResolvedValue(fakeUnit({ isActive: false }));
      mockPrisma.unitStatusEvent.count.mockResolvedValue(0);
      mockPrisma.bookingUnit.count.mockResolvedValue(0);
      mockPrisma.workOrder.count.mockResolvedValue(0);
      mockPrisma.amenityRequest.count.mockResolvedValue(0);
      mockPrisma.fnbOrder.count.mockResolvedValue(0);
      mockPrisma.inspection.count.mockResolvedValue(0);
      mockPrisma[relation].count.mockResolvedValue(1);

      const res = await request(createApp()).delete('/api/v1/units/unit_1').set('Cookie', authCookie());

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('UNIT_HAS_HISTORY');
      expect(res.body.error.message).toContain('Deactivate');
      expect(mockPrisma.unit.delete).not.toHaveBeenCalled();
    },
  );

  it('deletes an inactive unit with zero history', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnit({ isActive: false }));
    mockPrisma.unitStatusEvent.count.mockResolvedValue(0);
    mockPrisma.bookingUnit.count.mockResolvedValue(0);
    mockPrisma.workOrder.count.mockResolvedValue(0);
    mockPrisma.amenityRequest.count.mockResolvedValue(0);
    mockPrisma.fnbOrder.count.mockResolvedValue(0);
    mockPrisma.inspection.count.mockResolvedValue(0);
    mockPrisma.unit.delete.mockResolvedValue(fakeUnit({ isActive: false }));

    const res = await request(createApp()).delete('/api/v1/units/unit_1').set('Cookie', authCookie());

    expect(res.status).toBe(204);
    expect(mockPrisma.unit.delete).toHaveBeenCalledWith({ where: { id: 'unit_1' } });
  });
});

describe('GET /api/v1/units/orderable', () => {
  it('requires fnb:create, not unit:read', async () => {
    // POC_HOUSEKEEPING holds unit:read but not fnb:create — proves this
    // route is gated on the F&B permission, not the general one.
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('POC_HOUSEKEEPING'));
    const res = await request(createApp()).get('/api/v1/units/orderable').set('Cookie', authCookie());
    expect(res.status).toBe(403);
  });

  // RESTAURANT_STAFF holds fnb:create but no unit:read at all (spec
  // §5.4's "unit read" row) — the whole reason this narrowly-scoped
  // route exists rather than reusing GET /units.
  it('succeeds for RESTAURANT_STAFF, who has fnb:create but not unit:read', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESTAURANT_STAFF'));
    mockPrisma.unit.findMany.mockResolvedValue([fakeUnit({ status: 'OCCUPIED' })]);

    const res = await request(createApp()).get('/api/v1/units/orderable').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.units).toHaveLength(1);
    expect(res.body.units[0].status).toBe('OCCUPIED');
  });
});

describe('POST /api/v1/units/:id/status', () => {
  it('allows a caller with unit:update_status to move CLEANED -> READY directly — no QC handoff (client decision, 2026-08-22, INSPECTED retired)', async () => {
    // Formerly a two-hop hand-off (CLEANED -> INSPECTED via workorder:verify,
    // then an automatic-only INSPECTED -> READY): the client corrected this
    // to a single manual step gated by the same housekeeping permission as
    // the rest of the cycle, since the person who cleans the room is the
    // same person who marks it ready.
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('POC_HOUSEKEEPING'));
    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnit({ status: 'CLEANED', version: 3 }));
    mockPrisma.unit.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(createApp())
      .post('/api/v1/units/unit_1/status')
      .set('Cookie', authCookie())
      .send({ toStatus: 'READY', version: 3 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'unit_1', status: 'READY', version: 4 });
    expect(mockPrisma.unit.updateMany).toHaveBeenCalledWith({
      where: { id: 'unit_1', version: 3 },
      data: { status: 'READY', version: { increment: 1 } },
    });
    expect(mockPrisma.unitStatusEvent.create).toHaveBeenCalledWith({
      data: {
        unitId: 'unit_1',
        fromStatus: 'CLEANED',
        toStatus: 'READY',
        actorId: 'user_1',
        note: undefined,
        source: 'MANUAL',
      },
    });
    // Spec §9.1: channel `property`, event `unit.status.changed`, payload
    // carries enough for the grid to patch its own state without a refetch.
    expect(mockRealtimeEmit).toHaveBeenCalledWith(
      'property',
      'unit.status.changed',
      expect.objectContaining({
        entityId: 'unit_1',
        actorId: 'user_1',
        fromStatus: 'CLEANED',
        toStatus: 'READY',
        version: 4,
        note: null,
      }),
    );
  });

  it('does not fail the status change when the realtime broadcast itself fails', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('POC_HOUSEKEEPING'));
    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnit({ status: 'CLEANED', version: 3 }));
    mockPrisma.unit.updateMany.mockResolvedValue({ count: 1 });
    mockRealtimeEmit.mockRejectedValue(new Error('Supabase Realtime unreachable'));

    const res = await request(createApp())
      .post('/api/v1/units/unit_1/status')
      .set('Cookie', authCookie())
      .send({ toStatus: 'READY', version: 3 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'unit_1', status: 'READY', version: 4 });
  });

  it('a room attendant holding only unit:update_status can now do CLEANED -> READY too — the QC gate is gone (previously 403 before INSPECTED was retired)', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('HOUSEKEEPING_STAFF'));
    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnit({ status: 'CLEANED', version: 3 }));
    mockPrisma.unit.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(createApp())
      .post('/api/v1/units/unit_1/status')
      .set('Cookie', authCookie())
      .send({ toStatus: 'READY', version: 3 });

    expect(res.status).toBe(200);
  });

  it('rejects INSPECTED as a target status — it is no longer a valid enum value to transition into', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('SYSTEM_ADMIN'));

    const res = await request(createApp())
      .post('/api/v1/units/unit_1/status')
      .set('Cookie', authCookie())
      .send({ toStatus: 'INSPECTED', version: 3 });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
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

  it('rejects the automatic-only READY -> OCCUPIED transition for a non-SYSTEM_ADMIN caller, even one holding unit:manage', async () => {
    // RESORT_MANAGER also holds unit:manage (same as SYSTEM_ADMIN) but is
    // deliberately excluded from the override — client decision,
    // 2026-08-22: this is a stopgap testing tool, not a normal
    // operational path RESORT_MANAGER should reach for day to day.
    // READY -> OCCUPIED is one of only two automatic-only transitions
    // remaining now that INSPECTED (and its automatic-only INSPECTED ->
    // READY hop) has been retired — CLEANED -> READY is a normal manual
    // step now, so no override applies to it any more.
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnit({ status: 'READY', version: 5 }));

    const res = await request(createApp())
      .post('/api/v1/units/unit_1/status')
      .set('Cookie', authCookie())
      .send({ toStatus: 'OCCUPIED', version: 5 });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVALID_TRANSITION');
    expect(mockPrisma.unit.updateMany).not.toHaveBeenCalled();
  });

  it('allows SYSTEM_ADMIN to override the automatic-only READY -> OCCUPIED transition, and audits it distinctly from a plain update', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('SYSTEM_ADMIN'));
    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnit({ status: 'READY', version: 5 }));
    mockPrisma.unit.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(createApp())
      .post('/api/v1/units/unit_1/status')
      .set('Cookie', authCookie())
      .send({ toStatus: 'OCCUPIED', version: 5, note: 'unsticking manually, no booking module yet' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'unit_1', status: 'OCCUPIED', version: 6 });
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'UNIT_STATUS_AUTOMATIC_TRANSITION_OVERRIDE',
          entity: 'Unit',
          entityId: 'unit_1',
          actorId: 'user_1',
        }),
      }),
    );
  });

  it('CLEANED -> READY needs no override any more — a plain unit:update_status caller succeeds where only SYSTEM_ADMIN could before', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('HOUSEKEEPING_STAFF'));
    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnit({ status: 'CLEANED', version: 5 }));
    mockPrisma.unit.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(createApp())
      .post('/api/v1/units/unit_1/status')
      .set('Cookie', authCookie())
      .send({ toStatus: 'READY', version: 5 });

    expect(res.status).toBe(200);
    // Not an override — no distinct audit tag, just the generic UPDATE
    // row the audit extension writes for every mutated Unit.
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
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

describe('POST /api/v1/units/:id/force-status', () => {
  it('rejects a caller without unit:force_status', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));

    const res = await request(createApp())
      .post('/api/v1/units/unit_1/force-status')
      .set('Cookie', authCookie())
      .send({ toStatus: 'READY', version: 3, note: 'fixing stale data' });

    expect(res.status).toBe(403);
    expect(mockPrisma.unit.updateMany).not.toHaveBeenCalled();
  });

  it('succeeds with an empty/missing note — note is optional, not required (client decision, 2026-08-22)', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('SYSTEM_ADMIN'));
    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnit({ status: 'CLEANED', version: 3 }));
    mockPrisma.unit.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(createApp())
      .post('/api/v1/units/unit_1/force-status')
      .set('Cookie', authCookie())
      .send({ toStatus: 'READY', version: 3, note: '' });

    expect(res.status).toBe(200);
    expect(mockPrisma.unit.updateMany).toHaveBeenCalledWith({
      where: { id: 'unit_1', version: 3 },
      data: { status: 'READY', version: { increment: 1 } },
    });
    expect(mockPrisma.unitStatusEvent.create).toHaveBeenCalledWith({
      data: {
        unitId: 'unit_1',
        fromStatus: 'CLEANED',
        toStatus: 'READY',
        actorId: 'user_1',
        note: '',
        source: 'FORCED_CORRECTION',
      },
    });

    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnit({ status: 'CLEANED', version: 3 }));
    const res2 = await request(createApp())
      .post('/api/v1/units/unit_1/force-status')
      .set('Cookie', authCookie())
      .send({ toStatus: 'READY', version: 3 });

    expect(res2.status).toBe(200);
    expect(mockPrisma.unitStatusEvent.create).toHaveBeenCalledWith({
      data: {
        unitId: 'unit_1',
        fromStatus: 'CLEANED',
        toStatus: 'READY',
        actorId: 'user_1',
        note: undefined,
        source: 'FORCED_CORRECTION',
      },
    });
  });

  it('allows SYSTEM_ADMIN to jump directly to any status, bypassing the transition table, and audits it distinctly', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('SYSTEM_ADMIN'));
    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnit({ status: 'VACANT_DIRTY', version: 0 }));
    mockPrisma.unit.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(createApp())
      .post('/api/v1/units/unit_1/force-status')
      .set('Cookie', authCookie())
      .send({ toStatus: 'OCCUPIED', version: 0, note: 'guest is already checked in, staff forgot to update' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'unit_1', status: 'OCCUPIED', version: 1 });
    expect(mockPrisma.unit.updateMany).toHaveBeenCalledWith({
      where: { id: 'unit_1', version: 0 },
      data: { status: 'OCCUPIED', version: { increment: 1 } },
    });
    expect(mockPrisma.unitStatusEvent.create).toHaveBeenCalledWith({
      data: {
        unitId: 'unit_1',
        fromStatus: 'VACANT_DIRTY',
        toStatus: 'OCCUPIED',
        actorId: 'user_1',
        note: 'guest is already checked in, staff forgot to update',
        source: 'FORCED_CORRECTION',
      },
    });
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'UNIT_STATUS_FORCED_CORRECTION',
          entity: 'Unit',
          entityId: 'unit_1',
          actorId: 'user_1',
          after: expect.objectContaining({
            label: 'Forced correction — bypassed the normal status sequence',
          }),
        }),
      }),
    );
    expect(mockRealtimeEmit).toHaveBeenCalledWith(
      'property',
      'unit.status.changed',
      expect.objectContaining({
        entityId: 'unit_1',
        actorId: 'user_1',
        fromStatus: 'VACANT_DIRTY',
        toStatus: 'OCCUPIED',
        version: 1,
        note: 'guest is already checked in, staff forgot to update',
      }),
    );
  });

  it('returns 409 on a stale version', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('SYSTEM_ADMIN'));
    mockPrisma.unit.findFirst.mockResolvedValue(fakeUnit({ status: 'CLEANED', version: 5 }));
    mockPrisma.unit.updateMany.mockResolvedValue({ count: 0 });

    const res = await request(createApp())
      .post('/api/v1/units/unit_1/force-status')
      .set('Cookie', authCookie())
      .send({ toStatus: 'READY', version: 1, note: 'correcting stale data' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('VERSION_CONFLICT');
  });

  it('rejects INSPECTED in the force-correction dropdown too — the 8-status dropdown is now 5 (client decision, 2026-08-22)', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('SYSTEM_ADMIN'));

    const res = await request(createApp())
      .post('/api/v1/units/unit_1/force-status')
      .set('Cookie', authCookie())
      .send({ toStatus: 'INSPECTED', version: 3, note: 'trying to force a retired status' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(mockPrisma.unit.updateMany).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown unit', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('SYSTEM_ADMIN'));
    mockPrisma.unit.findFirst.mockResolvedValue(null);

    const res = await request(createApp())
      .post('/api/v1/units/does_not_exist/force-status')
      .set('Cookie', authCookie())
      .send({ toStatus: 'READY', version: 0, note: 'correcting stale data' });

    expect(res.status).toBe(404);
  });
});

describe('GET /api/v1/units/dashboard', () => {
  it('requires unit:read', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESTAURANT_STAFF'));
    const res = await request(createApp()).get('/api/v1/units/dashboard').set('Cookie', authCookie());
    expect(res.status).toBe(403);
  });

  it('computes KPI counts and flags rooms dirty past the 3h threshold', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    const now = Date.now();
    const fourHoursAgo = new Date(now - 4 * 60 * 60 * 1000);
    const oneHourAgo = new Date(now - 60 * 60 * 1000);
    mockPrisma.unit.findMany.mockResolvedValue([
      fakeUnit({ id: 'unit_occupied', status: 'OCCUPIED', createdAt: fourHoursAgo }),
      fakeUnit({ id: 'unit_ready', status: 'READY', createdAt: fourHoursAgo }),
      fakeUnit({ id: 'unit_ooo', status: 'OUT_OF_ORDER', createdAt: fourHoursAgo }),
      fakeUnit({ id: 'unit_dirty_long', code: '102', name: 'Room 102', status: 'VACANT_DIRTY', createdAt: fourHoursAgo }),
      fakeUnit({ id: 'unit_dirty_recent', code: '103', name: 'Room 103', status: 'VACANT_DIRTY', createdAt: oneHourAgo }),
    ]);
    mockPrisma.unitStatusEvent.findMany.mockResolvedValue([
      { unitId: 'unit_dirty_long', createdAt: fourHoursAgo },
      { unitId: 'unit_dirty_recent', createdAt: oneHourAgo },
    ]);

    const res = await request(createApp()).get('/api/v1/units/dashboard').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.kpi).toEqual({
      occupied: 1,
      ready: 1,
      dirty: 2,
      outOfOrder: 1,
      urgentOpenWorkOrders: 0,
      checkinsToday: 0,
      checkoutsToday: 0,
      openFnbOrders: 0,
      // RESORT_MANAGER holds both remittance:read and quotation:read in
      // the real seed, so both keys are present here (see the dedicated
      // permission-scoping tests below for the omitted-vs-present cases).
      pendingRemittances: 0,
      pendingQuotations: 0,
    });
    expect(res.body.dirtyRooms).toHaveLength(1);
    expect(res.body.dirtyRooms[0]).toMatchObject({ id: 'unit_dirty_long', code: '102' });
  });

  it('falls back to the unit\'s createdAt when it has no status event yet', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000);
    mockPrisma.unit.findMany.mockResolvedValue([
      fakeUnit({ id: 'unit_never_touched', status: 'VACANT_DIRTY', createdAt: fourHoursAgo }),
    ]);
    mockPrisma.unitStatusEvent.findMany.mockResolvedValue([]);

    const res = await request(createApp()).get('/api/v1/units/dashboard').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.dirtyRooms).toHaveLength(1);
    expect(res.body.dirtyRooms[0].id).toBe('unit_never_touched');
  });

  // This test pins the end-to-end response shape (overdueMinutes, unit
  // info, merged into GET /units/dashboard). The where-clause itself
  // (dueAt < now && status not in DONE/VERIFIED/CANCELLED, per spec
  // §7.2) is exercised directly against the mocked findMany call in
  // workorders/service.test.ts.
  it('includes SLA-breached work orders in the attention queue', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.unit.findMany.mockResolvedValue([]);
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    mockPrisma.workOrder.findMany.mockResolvedValue([
      {
        id: 'wo_breached',
        referenceNo: 'LWW-WO-0009',
        title: 'Broken AC unit',
        department: 'MAINTENANCE',
        dueAt: twoHoursAgo,
        unit: { id: 'unit_5', code: '105', name: 'Room 105' },
      },
    ]);

    const res = await request(createApp()).get('/api/v1/units/dashboard').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.slaBreachedWorkOrders).toHaveLength(1);
    expect(res.body.slaBreachedWorkOrders[0]).toMatchObject({
      id: 'wo_breached',
      referenceNo: 'LWW-WO-0009',
      unitCode: '105',
    });
    expect(res.body.slaBreachedWorkOrders[0].overdueMinutes).toBeGreaterThanOrEqual(119);
  });

  it('returns an empty SLA-breach list when no work orders are past due', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.unit.findMany.mockResolvedValue([]);
    mockPrisma.workOrder.findMany.mockResolvedValue([]);

    const res = await request(createApp()).get('/api/v1/units/dashboard').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.slaBreachedWorkOrders).toEqual([]);
  });

  it('counts open urgent work orders via workOrder.count, not the SLA-breach findMany', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.unit.findMany.mockResolvedValue([]);
    mockPrisma.workOrder.count.mockResolvedValue(3);

    const res = await request(createApp()).get('/api/v1/units/dashboard').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.kpi.urgentOpenWorkOrders).toBe(3);
    expect(mockPrisma.workOrder.count).toHaveBeenCalledWith({
      where: { deletedAt: null, priority: 'URGENT', status: { notIn: ['DONE', 'VERIFIED', 'CANCELLED'] } },
    });
  });

  // Replaces spec's original "arrivals/departures today" concept, which
  // assumed a date-based internal reservation system this app no longer
  // has (see the Check-in/Check-out redesign) — counts real
  // UnitStatusEvent rows created today instead.
  // Spec §3.2: "'today'... resolve[s] against Asia/Manila regardless of
  // where the browser sits." Same principle applies server-side (a
  // Netlify function's process TZ is not guaranteed to be PHT) — this
  // pins the boundary to real Asia/Manila midnight, not just "midnight in
  // whatever TZ the test runner happens to be in," which `getHours() ===
  // 0` alone can't distinguish. Same UTC-offset-comparison approach as
  // jobs/ownerDigest.test.ts's "yesterday" boundary tests.
  it('counts check-ins and check-outs logged today from UnitStatusEvent, scoped to Asia/Manila midnight', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.unit.findMany.mockResolvedValue([]);
    mockPrisma.unitStatusEvent.count.mockResolvedValueOnce(5).mockResolvedValueOnce(4);

    const now = new Date();
    const nowInManila = new TZDate(now, 'Asia/Manila');
    const expectedStartOfToday = new TZDate(
      nowInManila.getFullYear(),
      nowInManila.getMonth(),
      nowInManila.getDate(),
      0,
      0,
      'Asia/Manila',
    );

    const res = await request(createApp()).get('/api/v1/units/dashboard').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.kpi.checkinsToday).toBe(5);
    expect(res.body.kpi.checkoutsToday).toBe(4);

    const calls = mockPrisma.unitStatusEvent.count.mock.calls;
    expect(calls[0]![0]).toMatchObject({ where: { fromStatus: 'READY', toStatus: 'OCCUPIED' } });
    expect(calls[0]![0].where.createdAt.gte.getTime()).toBe(expectedStartOfToday.getTime());
    expect(calls[1]![0]).toMatchObject({ where: { fromStatus: 'OCCUPIED', toStatus: 'VACANT_DIRTY' } });
    expect(calls[1]![0].where.createdAt.gte.getTime()).toBe(expectedStartOfToday.getTime());
  });

  // Real gap found live-testing, 2026-08-25: this KPI card said "Coming in
  // M5" until now. countOpenFnbOrders's own where-clause (RECEIVED/
  // PREPARING/READY, ADVANCE_ORDER lead-time gate) is exercised directly in
  // fnb/service.test.ts; this just pins that it reaches the dashboard.
  it('reports open F&B tickets via countOpenFnbOrders', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.unit.findMany.mockResolvedValue([]);
    mockPrisma.fnbOrder.count.mockResolvedValue(7);

    const res = await request(createApp()).get('/api/v1/units/dashboard').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.kpi.openFnbOrders).toBe(7);
  });

  // Same reasoning as the SLA-breach comment above: listOverdueAmenityRequests's
  // own where-clause (status OVERDUE, or ISSUED past dueBackAt) is exercised
  // directly in amenities/service.test.ts; this pins the end-to-end shape.
  it('includes overdue amenity requests in the attention queue', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.unit.findMany.mockResolvedValue([]);
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    mockPrisma.amenityRequest.findMany.mockResolvedValue([
      {
        id: 'amenity_overdue',
        referenceNo: 'LWW-AM-0004',
        status: 'OVERDUE',
        amenityItemName: 'Beach towel',
        amenityItem: { name: 'Beach towel' },
        unit: { code: '201' },
        dueBackAt: oneHourAgo,
      },
      {
        id: 'amenity_issued_past_due',
        referenceNo: 'LWW-AM-0005',
        status: 'ISSUED',
        amenityItemName: null,
        amenityItem: { name: 'Kayak' },
        unit: { code: '202' },
        dueBackAt: oneHourAgo,
      },
    ]);

    const res = await request(createApp()).get('/api/v1/units/dashboard').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.overdueAmenityRequests).toHaveLength(2);
    expect(res.body.overdueAmenityRequests[0]).toMatchObject({
      id: 'amenity_overdue',
      referenceNo: 'LWW-AM-0004',
      itemName: 'Beach towel',
      unitCode: '201',
    });
    expect(res.body.overdueAmenityRequests[0].overdueMinutes).toBeGreaterThanOrEqual(59);
    expect(res.body.overdueAmenityRequests[1]).toMatchObject({
      id: 'amenity_issued_past_due',
      itemName: 'Kayak',
      unitCode: '202',
    });
  });

  it('returns an empty overdue-amenities list when none are past due', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.unit.findMany.mockResolvedValue([]);
    mockPrisma.amenityRequest.findMany.mockResolvedValue([]);

    const res = await request(createApp()).get('/api/v1/units/dashboard').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.overdueAmenityRequests).toEqual([]);
  });

  // Client-directed feature, 2026-08-31: the first Command Center data
  // that isn't universally visible to every unit:read holder (see
  // getUnitsDashboard's own doc comment). POC_HOUSEKEEPING holds
  // unit:read but neither remittance:read nor quotation:read — this
  // pins that the two fields (and both queue arrays) are OMITTED from
  // the JSON entirely, not present as 0/[], since a 0 would be
  // indistinguishable on the wire from "the real count is zero."
  it('omits pendingRemittances/pendingQuotations and both queue arrays for a viewer without remittance:read/quotation:read', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('POC_HOUSEKEEPING'));
    mockPrisma.unit.findMany.mockResolvedValue([]);
    mockPrisma.remittanceRequest.findMany.mockResolvedValue([{ id: 'remit_1', referenceNo: 'RM-1', name: 'x', createdAt: new Date() }]);
    mockPrisma.quotationRequest.findMany.mockResolvedValue([{ id: 'quote_1', referenceNo: 'QT-1', name: 'y', createdAt: new Date() }]);

    const res = await request(createApp()).get('/api/v1/units/dashboard').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.kpi.pendingRemittances).toBeUndefined();
    expect(res.body.kpi.pendingQuotations).toBeUndefined();
    expect(res.body.remittanceRequests).toBeUndefined();
    expect(res.body.quotationRequests).toBeUndefined();
    expect('pendingRemittances' in res.body.kpi).toBe(false);
    expect('remittanceRequests' in res.body).toBe(false);
    // Confirms the omission is a genuine permission gate, not just an
    // empty result — the mocked data above is real and non-empty; a
    // caller without the permission must never see it, in any shape.
    expect(mockPrisma.remittanceRequest.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.quotationRequest.findMany).not.toHaveBeenCalled();
  });

  // ADMIN_STAFF holds both remittance:read and quotation:read in the
  // real seed (rolePermissions.ts) — confirms the fields are actually
  // wired end to end for a caller who does hold both.
  it('includes pendingRemittances/pendingQuotations and both queue arrays for a viewer with both permissions', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
    mockPrisma.unit.findMany.mockResolvedValue([]);
    const now = new Date();
    mockPrisma.remittanceRequest.findMany.mockResolvedValue([
      { id: 'remit_1', referenceNo: 'RM-260831-0001', name: 'Juan Dela Cruz', createdAt: now },
    ]);
    mockPrisma.quotationRequest.findMany.mockResolvedValue([
      { id: 'quote_1', referenceNo: 'QT-260831-0001', name: 'Maria Santos', createdAt: now },
    ]);

    const res = await request(createApp()).get('/api/v1/units/dashboard').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.kpi.pendingRemittances).toBe(1);
    expect(res.body.kpi.pendingQuotations).toBe(1);
    expect(res.body.remittanceRequests).toHaveLength(1);
    expect(res.body.remittanceRequests[0]).toMatchObject({ id: 'remit_1', referenceNo: 'RM-260831-0001' });
    expect(res.body.quotationRequests).toHaveLength(1);
    expect(res.body.quotationRequests[0]).toMatchObject({ id: 'quote_1', referenceNo: 'QT-260831-0001' });
  });

  // Only unresolved items count — same standard as dirty-room/SLA-breach/
  // overdue-amenity logic above. listPendingRemittances/
  // listPendingQuotations' own where-clauses (status FOR_VERIFICATION /
  // PENDING only) are pinned directly in their own service tests; this
  // confirms that filtering actually reaches the Command Center response.
  it('counts only FOR_VERIFICATION remittances and PENDING quotations, not VERIFIED/DONE ones', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('SYSTEM_ADMIN'));
    mockPrisma.unit.findMany.mockResolvedValue([]);
    // The service's own where-clause already excludes VERIFIED/DONE rows
    // at the query level, so the mock reflects that — this test's job is
    // to confirm the dashboard doesn't add a second, looser filter on
    // top that would let a resolved item back in.
    mockPrisma.remittanceRequest.findMany.mockResolvedValue([]);
    mockPrisma.quotationRequest.findMany.mockResolvedValue([]);

    const res = await request(createApp()).get('/api/v1/units/dashboard').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.kpi.pendingRemittances).toBe(0);
    expect(res.body.kpi.pendingQuotations).toBe(0);
    expect(res.body.remittanceRequests).toEqual([]);
    expect(res.body.quotationRequests).toEqual([]);
    expect(mockPrisma.remittanceRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { deletedAt: null, status: 'FOR_VERIFICATION' } }),
    );
    expect(mockPrisma.quotationRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { deletedAt: null, status: 'PENDING' } }),
    );
  });
});

// The independent-gate case — held only for remittance:read, or only for
// quotation:read — has no real role to exercise it through: every role in
// the actual seed (rolePermissions.ts) that holds either key holds both.
// Rather than skip the case or fake a role that doesn't exist, this calls
// getUnitsDashboard directly with a hand-built permissions object, the
// same EffectivePermissions shape the router passes through from
// req.authUser.permissions — a true unit test of the gating logic itself,
// decoupled from what any current role happens to grant.
describe('getUnitsDashboard permission gating (direct)', () => {
  it('includes only the remittance fields when permissions hold remittance:read but not quotation:read', async () => {
    mockPrisma.unit.findMany.mockResolvedValue([]);
    mockPrisma.remittanceRequest.findMany.mockResolvedValue([
      { id: 'remit_1', referenceNo: 'RM-1', name: 'x', createdAt: new Date() },
    ]);

    const { getUnitsDashboard } = await import('../../../src/modules/units/service.js');
    const dashboard = await getUnitsDashboard({ 'remittance:read': 'ALL' });

    expect(dashboard.kpi.pendingRemittances).toBe(1);
    expect(dashboard.remittanceRequests).toHaveLength(1);
    expect(dashboard.kpi.pendingQuotations).toBeUndefined();
    expect(dashboard.quotationRequests).toBeUndefined();
    expect(mockPrisma.quotationRequest.findMany).not.toHaveBeenCalled();
  });

  it('includes only the quotation fields when permissions hold quotation:read but not remittance:read', async () => {
    mockPrisma.unit.findMany.mockResolvedValue([]);
    mockPrisma.quotationRequest.findMany.mockResolvedValue([
      { id: 'quote_1', referenceNo: 'QT-1', name: 'y', createdAt: new Date() },
    ]);

    const { getUnitsDashboard } = await import('../../../src/modules/units/service.js');
    const dashboard = await getUnitsDashboard({ 'quotation:read': 'ALL' });

    expect(dashboard.kpi.pendingQuotations).toBe(1);
    expect(dashboard.quotationRequests).toHaveLength(1);
    expect(dashboard.kpi.pendingRemittances).toBeUndefined();
    expect(dashboard.remittanceRequests).toBeUndefined();
    expect(mockPrisma.remittanceRequest.findMany).not.toHaveBeenCalled();
  });

  it('includes neither when permissions hold neither key', async () => {
    mockPrisma.unit.findMany.mockResolvedValue([]);

    const { getUnitsDashboard } = await import('../../../src/modules/units/service.js');
    const dashboard = await getUnitsDashboard({});

    expect(dashboard.kpi.pendingRemittances).toBeUndefined();
    expect(dashboard.kpi.pendingQuotations).toBeUndefined();
    expect(dashboard.remittanceRequests).toBeUndefined();
    expect(dashboard.quotationRequests).toBeUndefined();
  });
});

describe('GET /api/v1/units/activity', () => {
  it('requires unit:read', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESTAURANT_STAFF'));
    const res = await request(createApp()).get('/api/v1/units/activity').set('Cookie', authCookie());
    expect(res.status).toBe(403);
  });

  it('returns recent status-change events across all units, newest first', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.unitStatusEvent.findMany.mockResolvedValue([
      {
        id: 'event_2',
        unitId: 'unit_1',
        fromStatus: 'CLEANING',
        toStatus: 'CLEANED',
        note: null,
        createdAt: new Date('2026-08-23T10:00:00Z'),
        unit: { code: '101', name: 'Room 101' },
        actor: { fullName: 'Room Attendant 1 (Demo)' },
      },
    ]);

    const res = await request(createApp()).get('/api/v1/units/activity').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.events).toEqual([
      {
        id: 'event_2',
        unitId: 'unit_1',
        unitCode: '101',
        unitName: 'Room 101',
        fromStatus: 'CLEANING',
        toStatus: 'CLEANED',
        note: null,
        actorName: 'Room Attendant 1 (Demo)',
        createdAt: '2026-08-23T10:00:00.000Z',
      },
    ]);
    expect(mockPrisma.unitStatusEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 20 }),
    );
  });

  it('clamps an oversized limit query param to the max', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.unitStatusEvent.findMany.mockResolvedValue([]);

    const res = await request(createApp())
      .get('/api/v1/units/activity?limit=9999')
      .set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(mockPrisma.unitStatusEvent.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 50 }));
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
