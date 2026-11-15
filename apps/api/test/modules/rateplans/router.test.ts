import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPrisma = {
  user: { findFirst: vi.fn() },
  ratePlan: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  ratePlanRate: { findUnique: vi.fn(), upsert: vi.fn(), delete: vi.fn() },
  unitType: { findFirst: vi.fn() },
};

vi.mock('../../../src/lib/prisma.js', () => ({ prisma: mockPrisma }));

const { createApp } = await import('../../../src/app.js');
const { signAccessToken } = await import('../../../src/modules/auth/tokens.js');

function userWithRole(roleKey: string) {
  return {
    id: 'user_1',
    employeeCode: 'LWW-030',
    fullName: 'Admin (Demo)',
    email: null,
    department: 'FRONT_OFFICE',
    isActive: true,
    mustChangePassword: false,
    deletedAt: null,
    roles: [{ role: { key: roleKey } }],
  };
}

function authCookie() {
  return [`lwwbr_access=${signAccessToken('user_1')}`];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.unitType.findFirst.mockResolvedValue({ id: 'unittype_1', name: 'Family Room', deletedAt: null });
});

// Spec.md §13 decision 29 (2026-11-15): named rate plans the cashier
// explicitly chooses at billing time, replacing the never-built
// RateRule design — see spec.md §13.3 for the full plan. This file
// covers the admin CRUD surface (rateplan:manage); billing/router.test.ts
// covers the cashier-facing suggestion endpoint and the ROOM-charge
// pricing/mismatch behavior that actually consumes a RatePlan.
describe('Rate plans (admin CRUD)', () => {
  it('lists rate plans with their rates and unit type names joined', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('SYSTEM_ADMIN'));
    mockPrisma.ratePlan.findMany.mockResolvedValue([
      {
        id: 'plan_1',
        name: 'Standard',
        startDate: null,
        endDate: null,
        weekdayMask: null,
        isActive: true,
        rates: [{ id: 'rate_1', ratePlanId: 'plan_1', unitTypeId: 'unittype_1', rate: 1500, unitType: { id: 'unittype_1', name: 'Family Room' } }],
      },
    ]);

    const res = await request(createApp()).get('/api/v1/rate-plans').set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.ratePlans).toHaveLength(1);
    expect(res.body.ratePlans[0].rates[0].rate).toBe(1500);
    expect(res.body.ratePlans[0].rates[0].unitType.name).toBe('Family Room');
  });

  it('refuses listing without rateplan:manage', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
    const res = await request(createApp()).get('/api/v1/rate-plans').set('Cookie', authCookie());
    expect(res.status).toBe(403);
  });

  it('creates a rate plan with optional suggestion dates/weekday mask, recording who created it', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('SYSTEM_ADMIN'));
    mockPrisma.ratePlan.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: 'plan_xmas', ...data, rates: [] }),
    );

    const res = await request(createApp())
      .post('/api/v1/rate-plans')
      .set('Cookie', authCookie())
      .send({ name: 'December Xmas', startDate: '2026-12-01', endDate: '2026-12-31' });

    expect(res.status).toBe(201);
    expect(res.body.ratePlan.name).toBe('December Xmas');
    expect(mockPrisma.ratePlan.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ createdById: 'user_1' }) }),
    );
  });

  it('creates a rate plan with no suggestion fields at all (an "Off-season" catch-all)', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('SYSTEM_ADMIN'));
    mockPrisma.ratePlan.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: 'plan_off', ...data, rates: [] }),
    );

    const res = await request(createApp()).post('/api/v1/rate-plans').set('Cookie', authCookie()).send({ name: 'Off-season' });

    expect(res.status).toBe(201);
    expect(mockPrisma.ratePlan.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ startDate: null, endDate: null, weekdayMask: null }) }),
    );
  });

  it('rejects creating a plan with no name', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('SYSTEM_ADMIN'));
    const res = await request(createApp()).post('/api/v1/rate-plans').set('Cookie', authCookie()).send({ name: '' });
    expect(res.status).toBe(422);
  });

  it('refuses creating without rateplan:manage', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
    const res = await request(createApp()).post('/api/v1/rate-plans').set('Cookie', authCookie()).send({ name: 'Weekend' });
    expect(res.status).toBe(403);
  });

  it('updates a plan — name, suggestion fields, and isActive (deactivation)', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('SYSTEM_ADMIN'));
    mockPrisma.ratePlan.findFirst.mockResolvedValue({ id: 'plan_1', name: 'Weekend', deletedAt: null });
    mockPrisma.ratePlan.update.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: 'plan_1', name: 'Weekend', ...data, rates: [] }),
    );

    const res = await request(createApp()).patch('/api/v1/rate-plans/plan_1').set('Cookie', authCookie()).send({ isActive: false });

    expect(res.status).toBe(200);
    expect(mockPrisma.ratePlan.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'plan_1' }, data: { isActive: false } }),
    );
  });

  it('clears a suggestion field with an explicit null, leaving others untouched', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('SYSTEM_ADMIN'));
    mockPrisma.ratePlan.findFirst.mockResolvedValue({ id: 'plan_1', name: 'Weekend', deletedAt: null });
    mockPrisma.ratePlan.update.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: 'plan_1', name: 'Weekend', ...data, rates: [] }),
    );

    const res = await request(createApp())
      .patch('/api/v1/rate-plans/plan_1')
      .set('Cookie', authCookie())
      .send({ weekdayMask: null });

    expect(res.status).toBe(200);
    expect(mockPrisma.ratePlan.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'plan_1' }, data: { weekdayMask: null } }),
    );
  });

  it('404s updating an unknown plan', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('SYSTEM_ADMIN'));
    mockPrisma.ratePlan.findFirst.mockResolvedValue(null);
    const res = await request(createApp()).patch('/api/v1/rate-plans/missing').set('Cookie', authCookie()).send({ isActive: false });
    expect(res.status).toBe(404);
  });

  it('soft-deletes a plan (deletedAt), and 404s for an unknown one', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('SYSTEM_ADMIN'));
    mockPrisma.ratePlan.findFirst.mockResolvedValue({ id: 'plan_1', name: 'Weekend', deletedAt: null });

    const res = await request(createApp()).delete('/api/v1/rate-plans/plan_1').set('Cookie', authCookie());
    expect(res.status).toBe(204);
    expect(mockPrisma.ratePlan.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'plan_1' }, data: { deletedAt: expect.any(Date) } }),
    );

    mockPrisma.ratePlan.findFirst.mockResolvedValue(null);
    const missing = await request(createApp()).delete('/api/v1/rate-plans/missing').set('Cookie', authCookie());
    expect(missing.status).toBe(404);
  });

  describe('Rate plan rates — one row per (plan, unit type)', () => {
    it('upserts a rate for a unit type under a plan', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(userWithRole('SYSTEM_ADMIN'));
      mockPrisma.ratePlan.findFirst.mockResolvedValue({ id: 'plan_1', name: 'Weekend', deletedAt: null });
      mockPrisma.ratePlanRate.upsert.mockResolvedValue({ id: 'rate_1', ratePlanId: 'plan_1', unitTypeId: 'unittype_1', rate: 1800 });

      const res = await request(createApp())
        .put('/api/v1/rate-plans/plan_1/rates/unittype_1')
        .set('Cookie', authCookie())
        .send({ rate: 1800 });

      expect(res.status).toBe(200);
      expect(res.body.rate.rate).toBe(1800);
      expect(mockPrisma.ratePlanRate.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { ratePlanId_unitTypeId: { ratePlanId: 'plan_1', unitTypeId: 'unittype_1' } },
          create: { ratePlanId: 'plan_1', unitTypeId: 'unittype_1', rate: 1800 },
          update: { rate: 1800 },
        }),
      );
    });

    it('404s setting a rate on an unknown plan', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(userWithRole('SYSTEM_ADMIN'));
      mockPrisma.ratePlan.findFirst.mockResolvedValue(null);
      const res = await request(createApp()).put('/api/v1/rate-plans/missing/rates/unittype_1').set('Cookie', authCookie()).send({ rate: 1800 });
      expect(res.status).toBe(404);
    });

    it('404s setting a rate for an unknown unit type', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(userWithRole('SYSTEM_ADMIN'));
      mockPrisma.ratePlan.findFirst.mockResolvedValue({ id: 'plan_1', name: 'Weekend', deletedAt: null });
      mockPrisma.unitType.findFirst.mockResolvedValue(null);
      const res = await request(createApp()).put('/api/v1/rate-plans/plan_1/rates/missing').set('Cookie', authCookie()).send({ rate: 1800 });
      expect(res.status).toBe(404);
    });

    it('rejects a negative rate', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(userWithRole('SYSTEM_ADMIN'));
      const res = await request(createApp()).put('/api/v1/rate-plans/plan_1/rates/unittype_1').set('Cookie', authCookie()).send({ rate: -1 });
      expect(res.status).toBe(422);
    });

    // Spec.md §13 decision 29: the client's own "fail loudly" escape
    // hatch — removing a plan's rate for one room type, exercised at
    // this endpoint, is what makes resolveRatePlanRate 422 the next
    // time that room type is charged under this plan.
    it('removes a rate for one room type, and 404s removing one that was never set', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(userWithRole('SYSTEM_ADMIN'));
      mockPrisma.ratePlanRate.findUnique.mockResolvedValue({ id: 'rate_1', ratePlanId: 'plan_1', unitTypeId: 'unittype_1', rate: 1800 });

      const res = await request(createApp()).delete('/api/v1/rate-plans/plan_1/rates/unittype_1').set('Cookie', authCookie());
      expect(res.status).toBe(204);
      expect(mockPrisma.ratePlanRate.delete).toHaveBeenCalledWith({
        where: { ratePlanId_unitTypeId: { ratePlanId: 'plan_1', unitTypeId: 'unittype_1' } },
      });

      mockPrisma.ratePlanRate.findUnique.mockResolvedValue(null);
      const missing = await request(createApp()).delete('/api/v1/rate-plans/plan_1/rates/unittype_1').set('Cookie', authCookie());
      expect(missing.status).toBe(404);
    });

    it('refuses setting a rate without rateplan:manage', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
      const res = await request(createApp()).put('/api/v1/rate-plans/plan_1/rates/unittype_1').set('Cookie', authCookie()).send({ rate: 1800 });
      expect(res.status).toBe(403);
    });
  });
});
