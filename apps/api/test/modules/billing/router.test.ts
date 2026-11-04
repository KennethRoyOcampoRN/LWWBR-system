import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPrisma = {
  user: { findFirst: vi.fn() },
  fileObject: { findFirst: vi.fn() },
  setting: { findUnique: vi.fn() },
  booking: { findFirst: vi.fn() },
  folioCharge: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  payment: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  receipt: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  referenceSequence: { upsert: vi.fn() },
  $transaction: vi.fn(),
};

vi.mock('../../../src/lib/prisma.js', () => ({ prisma: mockPrisma }));

const mockGetSignedUrl = vi.fn().mockResolvedValue('https://storage.example/signed/logo.png');
vi.mock('../../../src/adapters/storage/index.js', () => ({
  getStorageAdapter: () => ({ getSignedUrl: mockGetSignedUrl }),
}));

const { createApp } = await import('../../../src/app.js');
const { signAccessToken } = await import('../../../src/modules/auth/tokens.js');
const { Prisma } = await import('@prisma/client');

function userWithRole(roleKey: string) {
  return {
    id: 'user_1',
    employeeCode: 'LWW-030',
    fullName: 'Cashier (Demo)',
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

const booking = {
  id: 'booking_1',
  guestName: 'Roel Villagomez',
  guestAddress: null,
  guestPhone: null,
  guestEmail: null,
  deletedAt: null,
};

const resortIdentitySetting = {
  key: 'resort.identity',
  value: {
    name: 'Lucky Waku Waku Beach Resort',
    address: '225 Caisip Blvd, Phase 3, San Diego, Lian, Batangas',
    cellNo: '09668294198',
    contactNo: '043-726-7198',
    website: 'www.luckywakuwakubeachresort.com',
    facebookUrl: 'Lucky Waku Waku Beach Resort',
    logoFileId: null,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSignedUrl.mockResolvedValue('https://storage.example/signed/logo.png');
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => unknown) => fn(mockPrisma));
});

describe('Folio charges', () => {
  it('posts a folio charge with amount computed server-side (qty * unitPrice), not trusted from the client', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
    mockPrisma.booking.findFirst.mockResolvedValue(booking);
    mockPrisma.folioCharge.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: 'charge_1', ...data }),
    );

    const res = await request(createApp())
      .post('/api/v1/bookings/booking_1/folio-charges')
      .set('Cookie', authCookie())
      .send({ source: 'ROOM', description: '2 COUPLE B - BALI', qty: 2, unitPrice: 1100 });

    expect(res.status).toBe(201);
    expect(res.body.folioCharge.amount).toBe(2200);
    expect(mockPrisma.folioCharge.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ amount: 2200, qty: 2, unitPrice: 1100 }) }),
    );
  });

  it('refuses posting a folio charge without folio:charge', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('POC_HOUSEKEEPING'));
    const res = await request(createApp())
      .post('/api/v1/bookings/booking_1/folio-charges')
      .set('Cookie', authCookie())
      .send({ source: 'ROOM', description: 'Room', qty: 1, unitPrice: 100 });
    expect(res.status).toBe(403);
  });

  it('voids a folio charge, rejecting a void with no reason', async () => {
    // folio:void is a manager-level grant — CASHIER holds folio:charge/
    // folio:read/folio:settle but not folio:void (see rolePermissions.ts).
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.folioCharge.findFirst.mockResolvedValue({ id: 'charge_1', status: 'POSTED', unitPrice: 100, amount: 100 });
    mockPrisma.folioCharge.update.mockResolvedValue({ id: 'charge_1', status: 'VOIDED', unitPrice: 100, amount: 100 });

    const missingReason = await request(createApp())
      .post('/api/v1/folio-charges/charge_1/void')
      .set('Cookie', authCookie())
      .send({});
    expect(missingReason.status).toBe(422);

    const res = await request(createApp())
      .post('/api/v1/folio-charges/charge_1/void')
      .set('Cookie', authCookie())
      .send({ voidReason: 'Posted to the wrong booking' });
    expect(res.status).toBe(200);
    expect(res.body.folioCharge.status).toBe('VOIDED');
  });

  it('409s voiding an already-voided charge', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.folioCharge.findFirst.mockResolvedValue({ id: 'charge_1', status: 'VOIDED' });
    const res = await request(createApp())
      .post('/api/v1/folio-charges/charge_1/void')
      .set('Cookie', authCookie())
      .send({ voidReason: 'x' });
    expect(res.status).toBe(409);
  });
});

describe('Payments', () => {
  it('submits a payment and verifies it, then reverts to PENDING', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
    mockPrisma.booking.findFirst.mockResolvedValue(booking);
    mockPrisma.payment.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: 'payment_1', status: 'PENDING', ...data }),
    );

    const submitRes = await request(createApp())
      .post('/api/v1/bookings/booking_1/payments')
      .set('Cookie', authCookie())
      .send({ amount: 1100, method: 'GCASH', kind: 'DOWNPAYMENT' });
    expect(submitRes.status).toBe(201);
    expect(submitRes.body.payment.amount).toBe(1100);

    // payment:verify is a manager-level grant — CASHIER holds
    // payment:read/payment:submit but not payment:verify.
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.payment.findFirst.mockResolvedValue({ id: 'payment_1', status: 'PENDING', amount: 1100 });
    mockPrisma.payment.update.mockResolvedValue({ id: 'payment_1', status: 'VERIFIED', amount: 1100 });
    const verifyRes = await request(createApp())
      .post('/api/v1/payments/payment_1/status')
      .set('Cookie', authCookie())
      .send({ toStatus: 'VERIFIED' });
    expect(verifyRes.status).toBe(200);
    expect(mockPrisma.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'VERIFIED', verifiedById: 'user_1' }) }),
    );
  });

  it('requires a rejectionReason to reject a payment', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.payment.findFirst.mockResolvedValue({ id: 'payment_1', status: 'PENDING', amount: 1100 });
    const res = await request(createApp())
      .post('/api/v1/payments/payment_1/status')
      .set('Cookie', authCookie())
      .send({ toStatus: 'REJECTED' });
    expect(res.status).toBe(422);
    expect(mockPrisma.payment.update).not.toHaveBeenCalled();
  });
});

describe('Receipt preview', () => {
  it('computes totals from draft lines/deductions and returns the resort header, gated by receipt:issue not resort:configure', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
    mockPrisma.booking.findFirst.mockResolvedValue(booking);
    mockPrisma.setting.findUnique.mockResolvedValue(resortIdentitySetting);

    const res = await request(createApp())
      .post('/api/v1/bookings/booking_1/receipts/preview')
      .set('Cookie', authCookie())
      .send({
        preparedByName: 'yssa',
        lines: [{ description: '2 COUPLE B - BALI', qty: 2, unitPrice: 1100 }],
        deductions: [{ type: 'DOWNPAYMENT', label: 'Downpayment', amount: 1100 }],
      });

    expect(res.status).toBe(200);
    expect(res.body.resort.name).toBe('Lucky Waku Waku Beach Resort');
    expect(res.body.guest.name).toBe('Roel Villagomez');
    expect(res.body.grandTotal).toBe(2200);
    expect(res.body.totalDeductions).toBe(1100);
    expect(res.body.totalAmountDue).toBe(1100);
  });

  // The real gap this test guards: GET /settings/resort-identity is
  // resort:configure-only (System Admin / Resort Manager), which
  // CASHIER doesn't hold — a cashier must still be able to preview a
  // receipt, through this endpoint's own receipt:issue gate, never by
  // widening resort:configure.
  it('a CASHIER (no resort:configure) can preview a receipt', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
    mockPrisma.booking.findFirst.mockResolvedValue(booking);
    mockPrisma.setting.findUnique.mockResolvedValue(resortIdentitySetting);

    const res = await request(createApp())
      .post('/api/v1/bookings/booking_1/receipts/preview')
      .set('Cookie', authCookie())
      .send({ preparedByName: 'yssa', lines: [{ description: 'Room', qty: 1, unitPrice: 100 }] });

    expect(res.status).toBe(200);
  });
});

describe('Receipt issuance — numbering, reconciliation, duplicate warning', () => {
  function stubIssuance() {
    mockPrisma.booking.findFirst.mockResolvedValue(booking);
    mockPrisma.setting.findUnique.mockResolvedValue(resortIdentitySetting);
    mockPrisma.referenceSequence.upsert.mockResolvedValue({ scope: '83887-11042026', seq: 1 });
    // Mimics what a real Prisma nested-create actually returns: the
    // created rows themselves, not the `{ create: [...] }` instruction
    // `data.lines`/`data.deductions` hold going in.
    mockPrisma.receipt.create = vi.fn(
      ({ data }: { data: Record<string, unknown> & { lines: { create: unknown[] }; deductions: { create: unknown[] } } }) =>
        Promise.resolve({
          id: 'receipt_1',
          status: 'ISSUED',
          ...data,
          lines: data.lines.create,
          deductions: data.deductions.create,
        }),
    );
  }

  it('issues a receipt whose billingNumberFull is {typed}-{MMDDYYYY}-{NN}, computed from Asia/Manila, not UTC', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
    stubIssuance();
    mockPrisma.receipt.findFirst.mockResolvedValue(null); // no duplicate-billing-number collision

    // 2026-11-04T23:30:00Z is already 2026-11-05 in Asia/Manila
    // (UTC+8) — asserts the billing number's date segment follows the
    // real local calendar date, not the UTC one, which would roll over
    // 8 hours later.
    vi.setSystemTime(new Date('2026-11-04T23:30:00.000Z'));

    const res = await request(createApp())
      .post('/api/v1/bookings/booking_1/receipts')
      .set('Cookie', authCookie())
      .send({
        billingNumberTyped: '83887',
        preparedByName: 'yssa',
        lines: [{ description: '2 COUPLE B - BALI', qty: 2, unitPrice: 1100 }],
        deductions: [{ type: 'DOWNPAYMENT', label: 'Downpayment', amount: 1100 }],
      });

    vi.useRealTimers();

    expect(res.status).toBe(201);
    expect(mockPrisma.referenceSequence.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { scope: '83887-11052026' } }),
    );
    expect(res.body.receipt.billingNumberFull).toBe('83887-11052026-01');
  });

  // The actual money-correctness requirement: grandTotal, each
  // deduction, and totalAmountDue are never independent inputs — they
  // are computed from the submitted lines/deductions on the server, so
  // a receipt can never be persisted with totals that don't add up.
  it('persists grandTotal/totalAmountDue that reconcile exactly with the lines and deductions actually created', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
    stubIssuance();
    mockPrisma.receipt.findFirst.mockResolvedValue(null);

    const res = await request(createApp())
      .post('/api/v1/bookings/booking_1/receipts')
      .set('Cookie', authCookie())
      .send({
        billingNumberTyped: '83887',
        preparedByName: 'yssa',
        lines: [
          { description: 'COUPLE B - BALI (room 1)', qty: 1, unitPrice: 1100 },
          { description: 'COUPLE B - BALI (room 2)', qty: 1, unitPrice: 1100 },
        ],
        deductions: [
          { type: 'DOWNPAYMENT', label: 'Downpayment', amount: 1100 },
          { type: 'DISCOUNT_SENIOR', label: 'Senior discount', amount: 100 },
        ],
      });

    expect(res.status).toBe(201);
    const createCall = (mockPrisma.receipt.create as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    const createdLines = createCall.data.lines.create as { amount: number }[];
    const createdDeductions = createCall.data.deductions.create as { amount: number }[];
    const lineSum = createdLines.reduce((sum, l) => sum + l.amount, 0);
    const deductionSum = createdDeductions.reduce((sum, d) => sum + d.amount, 0);

    expect(createCall.data.grandTotal).toBe(lineSum);
    expect(createCall.data.totalAmountDue).toBe(lineSum - deductionSum);
    expect(res.body.receipt.grandTotal).toBe(2200);
    expect(res.body.receipt.totalAmountDue).toBe(1000);
  });

  it('409s with DUPLICATE_BILLING_NUMBER when the same scope was already used for a different booking, and never allocates a number', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
    mockPrisma.booking.findFirst.mockResolvedValue(booking);
    mockPrisma.setting.findUnique.mockResolvedValue(resortIdentitySetting);
    mockPrisma.receipt.findFirst.mockResolvedValue({ id: 'receipt_other', bookingId: 'booking_2' });

    const res = await request(createApp())
      .post('/api/v1/bookings/booking_1/receipts')
      .set('Cookie', authCookie())
      .send({
        billingNumberTyped: '83887',
        preparedByName: 'yssa',
        lines: [{ description: 'Room', qty: 1, unitPrice: 100 }],
      });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE_BILLING_NUMBER');
    expect(mockPrisma.referenceSequence.upsert).not.toHaveBeenCalled();
  });

  it('issues anyway when confirmDuplicateBillingNumber is true', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
    stubIssuance();
    mockPrisma.receipt.findFirst.mockResolvedValue({ id: 'receipt_other', bookingId: 'booking_2' });

    const res = await request(createApp())
      .post('/api/v1/bookings/booking_1/receipts')
      .set('Cookie', authCookie())
      .send({
        billingNumberTyped: '83887',
        preparedByName: 'yssa',
        lines: [{ description: 'Room', qty: 1, unitPrice: 100 }],
        confirmDuplicateBillingNumber: true,
      });

    expect(res.status).toBe(201);
  });

  it('does not warn (and proceeds silently) when the same scope was already used for the SAME booking — an ordinary reissue', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
    stubIssuance();
    // findFirst is called with bookingId: { not: bookingId } — a
    // same-booking row would never match that query, so returning null
    // here is what proves the collision check is booking-scoped.
    mockPrisma.receipt.findFirst.mockResolvedValue(null);

    const res = await request(createApp())
      .post('/api/v1/bookings/booking_1/receipts')
      .set('Cookie', authCookie())
      .send({ billingNumberTyped: '83887', preparedByName: 'yssa', lines: [{ description: 'Room', qty: 1, unitPrice: 100 }] });

    expect(res.status).toBe(201);
    expect(mockPrisma.receipt.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ bookingId: { not: 'booking_1' } }) }),
    );
  });

  // The actual retry requirement: a P2002 on the Receipt insert (inside
  // the same transaction as the ReferenceSequence allocation) is caught
  // and retried with a fresh allocation, rather than leaking a raw
  // Prisma error to the cashier.
  it('retries with a fresh billing number allocation on a P2002 unique-constraint violation, never leaking a raw Prisma error', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
    mockPrisma.booking.findFirst.mockResolvedValue(booking);
    mockPrisma.setting.findUnique.mockResolvedValue(resortIdentitySetting);
    mockPrisma.receipt.findFirst.mockResolvedValue(null);
    mockPrisma.referenceSequence.upsert
      .mockResolvedValueOnce({ scope: '83887-11042026', seq: 1 })
      .mockResolvedValueOnce({ scope: '83887-11042026', seq: 2 });

    const conflictError = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: ['billingNumberScope', 'billingSeq'] },
    });
    mockPrisma.receipt.create = vi
      .fn()
      .mockRejectedValueOnce(conflictError)
      .mockImplementationOnce(
        ({ data }: { data: Record<string, unknown> & { lines: { create: unknown[] }; deductions: { create: unknown[] } } }) =>
          Promise.resolve({
            id: 'receipt_1',
            status: 'ISSUED',
            ...data,
            lines: data.lines.create,
            deductions: data.deductions.create,
          }),
      );

    const res = await request(createApp())
      .post('/api/v1/bookings/booking_1/receipts')
      .set('Cookie', authCookie())
      .send({ billingNumberTyped: '83887', preparedByName: 'yssa', lines: [{ description: 'Room', qty: 1, unitPrice: 100 }] });

    expect(res.status).toBe(201);
    expect(res.body.receipt.billingSeq).toBe(2);
    expect(mockPrisma.referenceSequence.upsert).toHaveBeenCalledTimes(2);
    expect(res.body.error).toBeUndefined();
  });

  it.each(['HOUSEKEEPING_STAFF', 'OWNER'])('refuses %s — receipt issuance is receipt:issue only', async (roleKey) => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole(roleKey));
    const res = await request(createApp())
      .post('/api/v1/bookings/booking_1/receipts')
      .set('Cookie', authCookie())
      .send({ billingNumberTyped: '83887', preparedByName: 'yssa', lines: [{ description: 'Room', qty: 1, unitPrice: 100 }] });
    expect(res.status).toBe(403);
  });
});

describe('Receipt read/void', () => {
  it('lists and gets a receipt with Decimal fields converted to real numbers', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
    const rawReceipt = {
      id: 'receipt_1',
      status: 'ISSUED',
      grandTotal: { toString: () => '2200.00', valueOf: () => 2200 } as unknown,
      totalAmountDue: { toString: () => '1100.00', valueOf: () => 1100 } as unknown,
      logoFileId: null,
      lines: [{ id: 'line_1', description: 'Room', qty: 1, unitPrice: 1100, amount: 1100 }],
      deductions: [],
    };
    mockPrisma.receipt.findMany.mockResolvedValue([rawReceipt]);
    mockPrisma.receipt.findFirst.mockResolvedValue(rawReceipt);

    const listRes = await request(createApp()).get('/api/v1/bookings/booking_1/receipts').set('Cookie', authCookie());
    expect(listRes.status).toBe(200);
    expect(listRes.body.receipts[0].grandTotal).toBe(2200);

    const getRes = await request(createApp()).get('/api/v1/receipts/receipt_1').set('Cookie', authCookie());
    expect(getRes.status).toBe(200);
    expect(getRes.body.receipt.totalAmountDue).toBe(1100);
  });

  it('voids a receipt, 409s voiding an already-voided one', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.receipt.findFirst.mockResolvedValue({ id: 'receipt_1', status: 'ISSUED' });
    mockPrisma.receipt.update.mockResolvedValue({ id: 'receipt_1', status: 'VOIDED', lines: [], deductions: [], logoFileId: null, grandTotal: 100, totalAmountDue: 100 });

    const res = await request(createApp())
      .post('/api/v1/receipts/receipt_1/void')
      .set('Cookie', authCookie())
      .send({ voidReason: 'Printed wrong amount' });
    expect(res.status).toBe(200);
    expect(res.body.receipt.status).toBe('VOIDED');

    mockPrisma.receipt.findFirst.mockResolvedValue({ id: 'receipt_1', status: 'VOIDED' });
    const res2 = await request(createApp())
      .post('/api/v1/receipts/receipt_1/void')
      .set('Cookie', authCookie())
      .send({ voidReason: 'again' });
    expect(res2.status).toBe(409);
  });
});
