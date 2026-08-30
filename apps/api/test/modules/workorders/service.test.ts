import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPrisma = {
  workOrder: { findMany: vi.fn(), count: vi.fn() },
};

vi.mock('../../../src/lib/prisma.js', () => ({ prisma: mockPrisma }));

const { countUrgentOpenWorkOrders, listSlaBreachedWorkOrders, listUrgentSlaBreachedWorkOrders } = await import(
  '../../../src/modules/workorders/service.js'
);

beforeEach(() => {
  vi.clearAllMocks();
});

// Spec §7.2's own computed-field definition: `dueAt < now && status not in
// (DONE, VERIFIED, CANCELLED)`. This function has no HTTP route of its
// own — it's called internally from units/service.ts's getUnitsDashboard
// (see that module's router test for the end-to-end response shape) — so
// this test asserts directly against the Prisma where-clause it builds,
// which a mocked findMany can't otherwise exercise.
describe('listSlaBreachedWorkOrders', () => {
  it('queries for dueAt in the past and excludes DONE/VERIFIED/CANCELLED (but not REOPENED)', async () => {
    mockPrisma.workOrder.findMany.mockResolvedValue([]);

    await listSlaBreachedWorkOrders();

    expect(mockPrisma.workOrder.findMany).toHaveBeenCalledTimes(1);
    const call = mockPrisma.workOrder.findMany.mock.calls[0]![0];
    expect(call.where.deletedAt).toBeNull();
    expect(call.where.dueAt.lt).toBeInstanceOf(Date);
    expect(call.where.status.notIn).toEqual(['DONE', 'VERIFIED', 'CANCELLED']);
    expect(call.where.status.notIn).not.toContain('REOPENED');
  });

  it('maps a breached work order to overdueMinutes and unit fields', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    mockPrisma.workOrder.findMany.mockResolvedValue([
      {
        id: 'wo_1',
        referenceNo: 'WO-260824-0001',
        title: 'Broken AC unit',
        department: 'MAINTENANCE',
        dueAt: twoHoursAgo,
        unit: { id: 'unit_5', code: '105', name: 'Room 105' },
      },
    ]);

    const result = await listSlaBreachedWorkOrders();

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'wo_1',
      referenceNo: 'WO-260824-0001',
      title: 'Broken AC unit',
      department: 'MAINTENANCE',
      unitId: 'unit_5',
      unitCode: '105',
      unitName: 'Room 105',
    });
    expect(result[0]!.overdueMinutes).toBeGreaterThanOrEqual(119);
  });

  it('maps a breached work order with no unit to null unit fields', async () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    mockPrisma.workOrder.findMany.mockResolvedValue([
      {
        id: 'wo_2',
        referenceNo: 'WO-260824-0002',
        title: 'Restock front desk supplies',
        department: 'FRONT_DESK',
        dueAt: oneHourAgo,
        unit: null,
      },
    ]);

    const result = await listSlaBreachedWorkOrders();

    expect(result).toHaveLength(1);
    expect(result[0]!).toMatchObject({ unitId: null, unitCode: null, unitName: null });
  });
});

// Spec §8.2 KPI strip: "Open urgent work orders." Same "open" definition
// as listSlaBreachedWorkOrders above (status not in DONE/VERIFIED/
// CANCELLED, so REOPENED still counts), filtered to URGENT priority.
describe('countUrgentOpenWorkOrders', () => {
  it('queries for URGENT priority and excludes DONE/VERIFIED/CANCELLED', async () => {
    mockPrisma.workOrder.count.mockResolvedValue(2);

    const result = await countUrgentOpenWorkOrders();

    expect(result).toBe(2);
    expect(mockPrisma.workOrder.count).toHaveBeenCalledWith({
      where: {
        deletedAt: null,
        priority: 'URGENT',
        status: { notIn: ['DONE', 'VERIFIED', 'CANCELLED'] },
      },
    });
  });
});

// Spec §8.3's owner exception-alert trigger: "an urgent work order open
// past its SLA." Same breach definition as listSlaBreachedWorkOrders,
// narrowed to URGENT — see jobs/service.ts's runExceptionAlertsSweep for
// the dedup logic that consumes this (not this function's concern; it
// just answers "which tickets are breached right now").
describe('listUrgentSlaBreachedWorkOrders', () => {
  it('queries for URGENT priority, dueAt in the past, and excludes DONE/VERIFIED/CANCELLED', async () => {
    mockPrisma.workOrder.findMany.mockResolvedValue([]);

    await listUrgentSlaBreachedWorkOrders();

    expect(mockPrisma.workOrder.findMany).toHaveBeenCalledTimes(1);
    const call = mockPrisma.workOrder.findMany.mock.calls[0]![0];
    expect(call.where.deletedAt).toBeNull();
    expect(call.where.priority).toBe('URGENT');
    expect(call.where.dueAt.lt).toBeInstanceOf(Date);
    expect(call.where.status.notIn).toEqual(['DONE', 'VERIFIED', 'CANCELLED']);
  });

  it('maps a breached ticket to overdueMinutes and unit fields, same shape as listSlaBreachedWorkOrders', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    mockPrisma.workOrder.findMany.mockResolvedValue([
      {
        id: 'wo_1',
        referenceNo: 'WO-260826-0001',
        title: 'Generator down',
        department: 'MAINTENANCE',
        dueAt: twoHoursAgo,
        unit: { id: 'unit_5', code: 'GEN', name: 'Generator Room' },
      },
    ]);

    const result = await listUrgentSlaBreachedWorkOrders();

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 'wo_1', referenceNo: 'WO-260826-0001', unitCode: 'GEN' });
    expect(result[0]!.overdueMinutes).toBeGreaterThanOrEqual(119);
  });
});
