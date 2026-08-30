import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPrisma = {
  unit: { findMany: vi.fn() },
  unitStatusEvent: { findMany: vi.fn(), count: vi.fn() },
  incident: { count: vi.fn() },
  workOrder: { findMany: vi.fn() },
};

vi.mock('../../../src/lib/prisma.js', () => ({ prisma: mockPrisma }));

const { computeDigestContent, renderDigestEmail } = await import('../../../src/modules/jobs/ownerDigest.js');

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.unit.findMany.mockResolvedValue([]);
  mockPrisma.unitStatusEvent.findMany.mockResolvedValue([]);
  mockPrisma.unitStatusEvent.count.mockResolvedValue(0);
  mockPrisma.incident.count.mockResolvedValue(0);
  mockPrisma.workOrder.findMany.mockResolvedValue([]);
});

// Spec §3.2: "Never use the viewer's device timezone... report date
// boundaries resolve against Asia/Manila regardless of where the
// browser sits." This job has no browser at all, but the same principle
// applies to wherever it happens to run (a Netlify function's own
// process timezone is not guaranteed to be PHT).
describe('computeDigestContent — "yesterday" boundary', () => {
  it('resolves "yesterday" against Asia/Manila, not the process TZ, for a time that is a different calendar day in UTC', async () => {
    // 2026-08-26T01:00:00+08:00 (1am PHT) is still 2026-08-25T17:00:00Z
    // in UTC — a naive UTC-based "yesterday" would compute 2026-08-24,
    // one day too early.
    const now = new Date('2026-08-26T01:00:00+08:00');

    const content = await computeDigestContent(now);

    expect(content.dateLabel).toBe('2026-08-25');
    const arrivalsCall = mockPrisma.unitStatusEvent.count.mock.calls[0]![0];
    // The window is [2026-08-25T00:00 PHT, 2026-08-26T00:00 PHT) = UTC
    // 2026-08-24T16:00:00Z to 2026-08-25T16:00:00Z. Compared by getTime()
    // (real point in time), not toISOString() string equality — TZDate
    // renders its string form with the +08:00 offset kept rather than
    // normalized to "Z", even though the underlying instant is identical.
    expect(arrivalsCall.where.createdAt.gte.getTime()).toBe(Date.UTC(2026, 7, 24, 16, 0, 0));
    expect(arrivalsCall.where.createdAt.lt.getTime()).toBe(Date.UTC(2026, 7, 25, 16, 0, 0));
  });

  it('carries the same window into the incidents count query', async () => {
    const now = new Date('2026-08-26T12:00:00+08:00');

    await computeDigestContent(now);

    const incidentsCall = mockPrisma.incident.count.mock.calls[0]![0];
    expect(incidentsCall.where.createdAt.gte.getTime()).toBe(Date.UTC(2026, 7, 24, 16, 0, 0));
    expect(incidentsCall.where.createdAt.lt.getTime()).toBe(Date.UTC(2026, 7, 25, 16, 0, 0));
  });

  it('SLA-breached work orders are current-as-of-send, not scoped to "yesterday"', async () => {
    mockPrisma.workOrder.findMany.mockResolvedValue([
      {
        id: 'wo_1',
        referenceNo: 'WO-260826-0002',
        title: 'AC unit failure',
        department: 'MAINTENANCE',
        dueAt: new Date(Date.now() - 30 * 60_000),
        unit: null,
      },
    ]);

    const content = await computeDigestContent(new Date('2026-08-26T09:00:00+08:00'));

    expect(content.urgentBreachedWorkOrders).toHaveLength(1);
    expect(content.urgentBreachedWorkOrders[0]!.referenceNo).toBe('WO-260826-0002');
    // No date filter passed to this particular query at all — confirms
    // it isn't scoped by createdAt the way arrivals/incidents are.
    const woCall = mockPrisma.workOrder.findMany.mock.calls[0]![0];
    expect(woCall.where.createdAt).toBeUndefined();
  });
});

describe('renderDigestEmail', () => {
  it('labels revenue and the payment-verification queue as not tracked, rather than omitting them silently', () => {
    const { text, html } = renderDigestEmail({
      dateLabel: '2026-08-25',
      occupancyRate: 0.5,
      occupiedCount: 5,
      totalUnits: 10,
      arrivals: 3,
      incidentsCount: 1,
      urgentBreachedWorkOrders: [],
    });

    expect(text).toContain('Revenue: not tracked');
    expect(text).toContain('Payment verification queue: not tracked');
    expect(html).toContain('not tracked');
    expect(text).toContain('Occupancy: 50%');
  });

  it('renders a real deep link for each breached work order, and "None." when there are none', () => {
    const withBreach = renderDigestEmail({
      dateLabel: '2026-08-25',
      occupancyRate: null,
      occupiedCount: 0,
      totalUnits: 0,
      arrivals: 0,
      incidentsCount: 0,
      urgentBreachedWorkOrders: [
        { referenceNo: 'WO-260826-0001', title: 'Generator down', unitCode: 'GEN', overdueMinutes: 90, deepLink: 'https://example.com/work-orders?id=wo_1' },
      ],
    });
    expect(withBreach.html).toContain('href="https://example.com/work-orders?id=wo_1"');
    expect(withBreach.text).toContain('https://example.com/work-orders?id=wo_1');

    const withoutBreach = renderDigestEmail({
      dateLabel: '2026-08-25',
      occupancyRate: null,
      occupiedCount: 0,
      totalUnits: 0,
      arrivals: 0,
      incidentsCount: 0,
      urgentBreachedWorkOrders: [],
    });
    expect(withoutBreach.text).toContain('None.');
  });
});
