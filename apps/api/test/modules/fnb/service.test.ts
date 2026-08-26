import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPrisma = {
  fnbOrder: { count: vi.fn() },
  setting: { findUnique: vi.fn() },
};

vi.mock('../../../src/lib/prisma.js', () => ({ prisma: mockPrisma }));

const { countOpenFnbOrders } = await import('../../../src/modules/fnb/service.js');

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.setting.findUnique.mockResolvedValue(null);
});

// Command Center's "Open F&B tickets" KPI. "Open" mirrors exactly the
// population the kitchen board itself renders (listFnbOrders's boardOnly
// branch): RECEIVED/PREPARING/READY, with an ADVANCE_ORDER still excluded
// until its lead-time window opens. This function has no HTTP route of its
// own (called internally from units/service.ts's getUnitsDashboard, see
// that module's router test for the end-to-end response shape), so this
// pins the Prisma where-clause it builds directly.
describe('countOpenFnbOrders', () => {
  it('queries for RECEIVED/PREPARING/READY and excludes not-yet-due advance orders', async () => {
    mockPrisma.fnbOrder.count.mockResolvedValue(4);

    const result = await countOpenFnbOrders();

    expect(result).toBe(4);
    expect(mockPrisma.fnbOrder.count).toHaveBeenCalledTimes(1);
    const call = mockPrisma.fnbOrder.count.mock.calls[0]![0];
    expect(call.where.deletedAt).toBeNull();
    expect(call.where.status.in).toEqual(['RECEIVED', 'PREPARING', 'READY']);
    expect(call.where.OR).toEqual([
      { type: { not: 'ADVANCE_ORDER' } },
      { scheduledFor: { lte: expect.any(Date) } },
    ]);
  });

  it('falls back to the shared default lead time when no Setting row exists', async () => {
    mockPrisma.setting.findUnique.mockResolvedValue(null);
    mockPrisma.fnbOrder.count.mockResolvedValue(0);

    await countOpenFnbOrders();

    const call = mockPrisma.fnbOrder.count.mock.calls[0]![0];
    const cutoff = call.where.OR[1].scheduledFor.lte as Date;
    expect(cutoff.getTime()).toBeGreaterThan(Date.now());
  });

  it('reads the configured lead time from the fnb.advanceOrderLeadMinutes Setting row', async () => {
    mockPrisma.setting.findUnique.mockResolvedValue({ value: 120 });
    mockPrisma.fnbOrder.count.mockResolvedValue(0);

    const before = Date.now();
    await countOpenFnbOrders();

    const call = mockPrisma.fnbOrder.count.mock.calls[0]![0];
    const cutoff = (call.where.OR[1].scheduledFor.lte as Date).getTime();
    expect(cutoff).toBeGreaterThanOrEqual(before + 120 * 60_000 - 1000);
    expect(cutoff).toBeLessThanOrEqual(before + 120 * 60_000 + 5000);
  });
});
