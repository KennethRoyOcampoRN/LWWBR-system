import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPrisma = {
  amenityRequest: { findMany: vi.fn() },
};

vi.mock('../../../src/lib/prisma.js', () => ({ prisma: mockPrisma }));

const { listOverdueAmenityRequests } = await import('../../../src/modules/amenities/service.js');

beforeEach(() => {
  vi.clearAllMocks();
});

// Command Center's "Overdue amenities" attention-queue row. Same live
// computed-field pattern as workorders/service.ts's listSlaBreachedWorkOrders:
// status OVERDUE (already swept), OR status ISSUED with dueBackAt already
// past (not yet swept — the sweep only runs every 15 minutes). This function
// has no HTTP route of its own (called internally from units/service.ts's
// getUnitsDashboard, see that module's router test for the end-to-end
// response shape), so this pins the Prisma where-clause and mapping directly.
describe('listOverdueAmenityRequests', () => {
  it('queries for OVERDUE status or ISSUED past dueBackAt', async () => {
    mockPrisma.amenityRequest.findMany.mockResolvedValue([]);

    await listOverdueAmenityRequests();

    expect(mockPrisma.amenityRequest.findMany).toHaveBeenCalledTimes(1);
    const call = mockPrisma.amenityRequest.findMany.mock.calls[0]![0];
    expect(call.where.deletedAt).toBeNull();
    expect(call.where.OR).toEqual([
      { status: 'OVERDUE' },
      { status: 'ISSUED', dueBackAt: { lt: expect.any(Date) } },
    ]);
  });

  it('maps an overdue request to overdueMinutes, preferring the itemName snapshot', async () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    mockPrisma.amenityRequest.findMany.mockResolvedValue([
      {
        id: 'amenity_1',
        referenceNo: 'LWW-AM-0010',
        amenityItemName: 'Beach towel',
        amenityItem: { name: 'stale live name' },
        unit: { code: '201' },
        dueBackAt: oneHourAgo,
      },
    ]);

    const result = await listOverdueAmenityRequests();

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'amenity_1',
      referenceNo: 'LWW-AM-0010',
      itemName: 'Beach towel',
      unitCode: '201',
    });
    expect(result[0]!.overdueMinutes).toBeGreaterThanOrEqual(59);
  });

  it('falls back to the live amenityItem relation, then a placeholder, when the snapshot is missing', async () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    mockPrisma.amenityRequest.findMany.mockResolvedValue([
      {
        id: 'amenity_2',
        referenceNo: 'LWW-AM-0011',
        amenityItemName: null,
        amenityItem: { name: 'Kayak' },
        unit: null,
        dueBackAt: oneHourAgo,
      },
      {
        id: 'amenity_3',
        referenceNo: 'LWW-AM-0012',
        amenityItemName: null,
        amenityItem: null,
        unit: null,
        dueBackAt: oneHourAgo,
      },
    ]);

    const result = await listOverdueAmenityRequests();

    expect(result[0]).toMatchObject({ itemName: 'Kayak', unitCode: null });
    expect(result[1]).toMatchObject({ itemName: '(deleted item)', unitCode: null });
  });

  it('returns an empty list when nothing is overdue', async () => {
    mockPrisma.amenityRequest.findMany.mockResolvedValue([]);

    const result = await listOverdueAmenityRequests();

    expect(result).toEqual([]);
  });
});
