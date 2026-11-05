import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPrisma = {
  user: { findFirst: vi.fn() },
  fileObject: { findFirst: vi.fn() },
  setting: { findUnique: vi.fn() },
  booking: { findFirst: vi.fn(), findMany: vi.fn() },
  bookingUnit: { findFirst: vi.fn() },
  folioCharge: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  payment: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  receipt: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  receiptBooking: { findMany: vi.fn(), create: vi.fn() },
  fnbOrder: { findMany: vi.fn() },
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
  referenceNo: '83887',
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
  mockPrisma.receiptBooking.create.mockResolvedValue({ id: 'receipt_booking_1' });
  // gatherBookingIdsForBilling's own sibling-booking query — no siblings
  // by default (the entry booking alone is always included regardless).
  mockPrisma.booking.findMany.mockResolvedValue([]);
  // gatherReceiptLines's own source of truth — one posted charge by
  // default so a test exercising something downstream of it (billing-
  // number checks, the reconciliation guard) doesn't 422 on NO_CHARGES
  // first. Tests asserting specific totals override this explicitly.
  mockPrisma.folioCharge.findMany.mockResolvedValue([
    { id: 'charge_1', description: 'Room', qty: 1, unitPrice: 100, status: 'POSTED' },
  ]);
});

describe('Folio charges', () => {
  it('posts a MISC folio charge with amount computed server-side (qty * unitPrice), not trusted from the client', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
    mockPrisma.booking.findFirst.mockResolvedValue(booking);
    mockPrisma.folioCharge.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: 'charge_1', ...data }),
    );

    const res = await request(createApp())
      .post('/api/v1/bookings/booking_1/folio-charges')
      .set('Cookie', authCookie())
      .send({ source: 'MISC', description: 'Lost key fob', qty: 2, unitPrice: 1100 });

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
      .send({ source: 'MISC', description: 'Room', qty: 1, unitPrice: 100 });
    expect(res.status).toBe(403);
  });

  it('requires unitPrice for a non-ROOM charge', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
    const res = await request(createApp())
      .post('/api/v1/bookings/booking_1/folio-charges')
      .set('Cookie', authCookie())
      .send({ source: 'MISC', description: 'Lost key fob' });
    expect(res.status).toBe(422);
  });

  // Cashier-tab plan, spec.md §13 decision 16 (2026-11-05): "the cost of
  // the room/unit must be automatic based on what the system admin has
  // setup" — a ROOM charge is priced from UnitType.baseRate and the
  // billed BookingUnit's own date range, never from client input.
  describe('ROOM charges are priced automatically, never from client input', () => {
    const bookingUnit = {
      id: 'bu_1',
      bookingId: 'booking_1',
      deletedAt: null,
      occupiedFrom: new Date('2026-11-10T00:00:00.000Z'),
      occupiedTo: new Date('2026-11-12T00:00:00.000Z'),
      unit: { id: 'unit_1', code: 'R01', unitType: { baseRate: 1500 } },
      booking: { ...booking, departureDate: null },
    };

    it('computes unitPrice from UnitType.baseRate and qty from the night count, ignoring any client-submitted value', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
      mockPrisma.booking.findFirst.mockResolvedValue(booking);
      mockPrisma.bookingUnit.findFirst.mockResolvedValue(bookingUnit);
      mockPrisma.folioCharge.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'charge_1', ...data }),
      );

      const res = await request(createApp())
        .post('/api/v1/bookings/booking_1/folio-charges')
        .set('Cookie', authCookie())
        .send({ source: 'ROOM', sourceId: 'bu_1', description: 'R01 (2 nights)' });

      expect(res.status).toBe(201);
      expect(res.body.folioCharge.qty).toBe(2);
      expect(res.body.folioCharge.unitPrice).toBe(1500);
      expect(res.body.folioCharge.amount).toBe(3000);
    });

    it('422s with an explicit error — not a silent overwrite — when the client submits a unitPrice for ROOM', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
      const res = await request(createApp())
        .post('/api/v1/bookings/booking_1/folio-charges')
        .set('Cookie', authCookie())
        .send({ source: 'ROOM', sourceId: 'bu_1', description: 'R01', unitPrice: 999 });

      expect(res.status).toBe(422);
      expect(mockPrisma.folioCharge.create).not.toHaveBeenCalled();
    });

    it('422s when the client submits a qty for ROOM', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
      const res = await request(createApp())
        .post('/api/v1/bookings/booking_1/folio-charges')
        .set('Cookie', authCookie())
        .send({ source: 'ROOM', sourceId: 'bu_1', description: 'R01', qty: 2 });

      expect(res.status).toBe(422);
      expect(mockPrisma.folioCharge.create).not.toHaveBeenCalled();
    });

    it('422s when sourceId (the BookingUnit assignment) is missing for ROOM', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
      const res = await request(createApp())
        .post('/api/v1/bookings/booking_1/folio-charges')
        .set('Cookie', authCookie())
        .send({ source: 'ROOM', description: 'R01' });

      expect(res.status).toBe(422);
      expect(mockPrisma.folioCharge.create).not.toHaveBeenCalled();
    });

    it('422s when sourceId does not resolve to an existing assignment on this booking', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
      mockPrisma.booking.findFirst.mockResolvedValue(booking);
      mockPrisma.bookingUnit.findFirst.mockResolvedValue(null);

      const res = await request(createApp())
        .post('/api/v1/bookings/booking_1/folio-charges')
        .set('Cookie', authCookie())
        .send({ source: 'ROOM', sourceId: 'bu_bogus', description: 'R01' });

      expect(res.status).toBe(422);
      expect(mockPrisma.folioCharge.create).not.toHaveBeenCalled();
    });

    it('falls back to the booking\'s own departureDate for an open-ended assignment (occupiedTo still null)', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
      mockPrisma.booking.findFirst.mockResolvedValue(booking);
      mockPrisma.bookingUnit.findFirst.mockResolvedValue({
        ...bookingUnit,
        occupiedTo: null,
        booking: { ...booking, departureDate: new Date('2026-11-13T00:00:00.000Z') },
      });
      mockPrisma.folioCharge.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'charge_1', ...data }),
      );

      const res = await request(createApp())
        .post('/api/v1/bookings/booking_1/folio-charges')
        .set('Cookie', authCookie())
        .send({ source: 'ROOM', sourceId: 'bu_1', description: 'R01 (added mid-stay)' });

      expect(res.status).toBe(201);
      expect(res.body.folioCharge.qty).toBe(3); // Nov 10 -> Nov 13
    });
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
  // Cashier-tab plan, spec.md §13 decision 16 (2026-11-05): lines are no
  // longer client input — previewReceipt builds them itself from the
  // booking's own posted FolioCharge rows (gatherReceiptLines), so what's
  // previewed can never price differently than what issueReceipt would
  // actually persist.
  it('computes totals from posted FolioCharge rows (not client input) plus client-typed deductions, gated by receipt:issue not resort:configure', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
    mockPrisma.booking.findFirst.mockResolvedValue(booking);
    mockPrisma.setting.findUnique.mockResolvedValue(resortIdentitySetting);
    mockPrisma.folioCharge.findMany.mockResolvedValue([
      { id: 'charge_1', description: '2 COUPLE B - BALI', qty: 2, unitPrice: 1100, status: 'POSTED' },
    ]);

    const res = await request(createApp())
      .post('/api/v1/bookings/booking_1/receipts/preview')
      .set('Cookie', authCookie())
      .send({
        preparedByName: 'yssa',
        deductions: [{ type: 'DOWNPAYMENT', label: 'Downpayment', amount: 1100 }],
        // A client-submitted lines array is inert — there is no path
        // left that reads it, so it has zero effect on the totals below.
        lines: [{ description: 'Should be ignored', qty: 99, unitPrice: 99999 }],
      });

    expect(res.status).toBe(200);
    expect(res.body.resort.name).toBe('Lucky Waku Waku Beach Resort');
    expect(res.body.guest.name).toBe('Roel Villagomez');
    expect(res.body.lines).toHaveLength(1);
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
      .send({ preparedByName: 'yssa' });

    expect(res.status).toBe(200);
  });

  // Build plan stage 4: the billing page's first preview call fires
  // the moment a booking is opened, before any charge has been posted —
  // its only purpose at that point is fetching the resort header/guest
  // block (there's no standalone booking-read endpoint).
  it('previews with no charges posted yet (zero totals), just the resort header and guest block', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
    mockPrisma.booking.findFirst.mockResolvedValue(booking);
    mockPrisma.setting.findUnique.mockResolvedValue(resortIdentitySetting);
    mockPrisma.folioCharge.findMany.mockResolvedValue([]);

    const res = await request(createApp())
      .post('/api/v1/bookings/booking_1/receipts/preview')
      .set('Cookie', authCookie())
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.lines).toEqual([]);
    expect(res.body.grandTotal).toBe(0);
    expect(res.body.totalAmountDue).toBe(0);
    expect(res.body.guest.name).toBe('Roel Villagomez');
  });

  // Client decision, 2026-11-04: nothing capped totalDeductions against
  // grandTotal — a mistyped downpayment could otherwise yield a receipt
  // with a negative Total Amount Due. Rejected outright rather than
  // silently persisted; a genuine refund-due case is a different
  // document, out of scope here. Checked in preview (not just at the
  // real issue call) so the cashier sees this before attempting to
  // issue, not after.
  it('422s when deductions exceed the grand total, naming the overage', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
    mockPrisma.booking.findFirst.mockResolvedValue(booking);
    mockPrisma.setting.findUnique.mockResolvedValue(resortIdentitySetting);
    mockPrisma.folioCharge.findMany.mockResolvedValue([
      { id: 'charge_1', description: 'Room', qty: 1, unitPrice: 1100, status: 'POSTED' },
    ]);

    const res = await request(createApp())
      .post('/api/v1/bookings/booking_1/receipts/preview')
      .set('Cookie', authCookie())
      .send({
        preparedByName: 'yssa',
        deductions: [{ type: 'DOWNPAYMENT', label: 'Downpayment', amount: 1500 }],
      });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('DEDUCTIONS_EXCEED_GRAND_TOTAL');
    expect(res.body.error.message).toContain('400.00');
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

    mockPrisma.folioCharge.findMany.mockResolvedValue([
      { id: 'charge_1', description: '2 COUPLE B - BALI', qty: 2, unitPrice: 1100, status: 'POSTED' },
    ]);

    const res = await request(createApp())
      .post('/api/v1/bookings/booking_1/receipts')
      .set('Cookie', authCookie())
      .send({
        billingNumberTyped: '83887',
        preparedByName: 'yssa',
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
    mockPrisma.folioCharge.findMany.mockResolvedValue([
      { id: 'charge_1', description: 'COUPLE B - BALI (room 1)', qty: 1, unitPrice: 1100, status: 'POSTED' },
      { id: 'charge_2', description: 'COUPLE B - BALI (room 2)', qty: 1, unitPrice: 1100, status: 'POSTED' },
    ]);

    const res = await request(createApp())
      .post('/api/v1/bookings/booking_1/receipts')
      .set('Cookie', authCookie())
      .send({
        billingNumberTyped: '83887',
        preparedByName: 'yssa',
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

  it('409s with DUPLICATE_BILLING_NUMBER when the same scope was already used for a different external booking, and never allocates a number', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
    mockPrisma.booking.findFirst.mockResolvedValue(booking);
    mockPrisma.setting.findUnique.mockResolvedValue(resortIdentitySetting);
    mockPrisma.receipt.findFirst.mockResolvedValue({ id: 'receipt_other', bookingId: 'booking_2', externalBookingRef: '99999' });

    const res = await request(createApp())
      .post('/api/v1/bookings/booking_1/receipts')
      .set('Cookie', authCookie())
      .send({
        billingNumberTyped: '83887',
        preparedByName: 'yssa',
      });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE_BILLING_NUMBER');
    expect(mockPrisma.referenceSequence.upsert).not.toHaveBeenCalled();
  });

  it('issues anyway when confirmDuplicateBillingNumber is true', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
    stubIssuance();
    mockPrisma.receipt.findFirst.mockResolvedValue({ id: 'receipt_other', bookingId: 'booking_2', externalBookingRef: '99999' });

    const res = await request(createApp())
      .post('/api/v1/bookings/booking_1/receipts')
      .set('Cookie', authCookie())
      .send({
        billingNumberTyped: '83887',
        preparedByName: 'yssa',
        confirmDuplicateBillingNumber: true,
      });

    expect(res.status).toBe(201);
  });

  it('does not warn (and proceeds silently) when the same scope was already used for the SAME external booking — an ordinary reissue', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
    stubIssuance();
    // Corrected 2026-11-05 (spec.md §13.4): the collision check now
    // compares externalBookingRef, not bookingId — a second room
    // billed under the same external ID (a legitimate group, or an
    // ordinary reissue) must never trigger this. findFirst is called
    // with an OR of { externalBookingRef: { not: '83887' } } and
    // { externalBookingRef: null } — a same-external-booking row would
    // never match that query, so returning null here is what proves
    // the collision check is scoped correctly.
    mockPrisma.receipt.findFirst.mockResolvedValue(null);

    const res = await request(createApp())
      .post('/api/v1/bookings/booking_1/receipts')
      .set('Cookie', authCookie())
      .send({ billingNumberTyped: '83887', preparedByName: 'yssa' });

    expect(res.status).toBe(201);
    expect(mockPrisma.receipt.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ externalBookingRef: { not: '83887' } }, { externalBookingRef: null }],
        }),
      }),
    );
  });

  // Pins the exact gap caught in review (spec.md §13.4): the typed
  // billing number must equal this booking's own external ID, not just
  // not-collide with someone else's. A mismatch is rejected outright
  // (422), never folded into the soft duplicate-warn above.
  it('422s with BILLING_NUMBER_MISMATCH when the typed billing number does not match this booking\'s own referenceNo', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
    mockPrisma.booking.findFirst.mockResolvedValue(booking); // referenceNo: '83887'
    mockPrisma.setting.findUnique.mockResolvedValue(resortIdentitySetting);

    const res = await request(createApp())
      .post('/api/v1/bookings/booking_1/receipts')
      .set('Cookie', authCookie())
      .send({ billingNumberTyped: '99999', preparedByName: 'yssa' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('BILLING_NUMBER_MISMATCH');
    expect(mockPrisma.receipt.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.referenceSequence.upsert).not.toHaveBeenCalled();
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
      .send({ billingNumberTyped: '83887', preparedByName: 'yssa' });

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
      .send({ billingNumberTyped: '83887', preparedByName: 'yssa' });
    expect(res.status).toBe(403);
  });

  // Same rejection as the preview test, exercised here at the real
  // issue call — and proving no billing number is ever allocated for a
  // receipt that gets rejected: a mistyped deduction must not burn a
  // sequence number before the validation error is raised.
  it('422s and allocates no billing number when deductions exceed the grand total', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
    mockPrisma.booking.findFirst.mockResolvedValue(booking);
    mockPrisma.setting.findUnique.mockResolvedValue(resortIdentitySetting);
    mockPrisma.receipt.findFirst.mockResolvedValue(null);
    mockPrisma.folioCharge.findMany.mockResolvedValue([
      { id: 'charge_1', description: 'Room', qty: 1, unitPrice: 1100, status: 'POSTED' },
    ]);

    const res = await request(createApp())
      .post('/api/v1/bookings/booking_1/receipts')
      .set('Cookie', authCookie())
      .send({
        billingNumberTyped: '83887',
        preparedByName: 'yssa',
        deductions: [{ type: 'DOWNPAYMENT', label: 'Downpayment', amount: 1500 }],
      });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('DEDUCTIONS_EXCEED_GRAND_TOTAL');
    expect(mockPrisma.referenceSequence.upsert).not.toHaveBeenCalled();
  });

  // The real reconciliation guard (post-Decimal-round-trip, not the
  // removed tautological one): proves it actually fires on a genuine
  // mismatch, by having the mocked create() return rows that disagree
  // with what was computed — simulating a serialization/rounding fault
  // introduced between computation and persistence, which the old
  // "compare an expression to itself" check could never have caught.
  it('500s with TOTALS_DO_NOT_RECONCILE if the persisted rows ever disagree with the computed totals', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
    stubIssuance();
    mockPrisma.receipt.findFirst.mockResolvedValue(null);
    mockPrisma.receipt.create = vi.fn(
      ({ data }: { data: Record<string, unknown> & { lines: { create: { amount: number }[] } } }) =>
        Promise.resolve({
          id: 'receipt_1',
          status: 'ISSUED',
          ...data,
          // Corrupted on the way "out" — the persisted line amount no
          // longer matches the grandTotal that was actually computed
          // and stored, simulating exactly the kind of fault this
          // guard exists to catch.
          lines: [{ ...data.lines.create[0]!, amount: data.lines.create[0]!.amount + 1 }],
          deductions: (data.deductions as { create: unknown[] }).create,
        }),
    );

    const res = await request(createApp())
      .post('/api/v1/bookings/booking_1/receipts')
      .set('Cookie', authCookie())
      .send({ billingNumberTyped: '83887', preparedByName: 'yssa' });

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('TOTALS_DO_NOT_RECONCILE');
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
    // listReceiptsForBooking queries ReceiptBooking, not Receipt.findMany
    // directly (corrected 2026-11-05, spec.md §13.4).
    mockPrisma.receiptBooking.findMany.mockResolvedValue([{ receipt: rawReceipt }]);
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

// Cashier-tab plan (spec.md §13.4, Stage B, 2026-11-05): the F&B
// pull-in's read side. Gathers across every Booking row sharing the
// entry booking's external ID, not just the entry-point row — the same
// keying fix the receipt model itself needed.
describe('GET /api/v1/bookings/:bookingId/unsettled-fnb-charges', () => {
  it('requires receipt:issue', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('HOUSEKEEPING_STAFF'));
    const res = await request(createApp()).get('/api/v1/bookings/booking_1/unsettled-fnb-charges').set('Cookie', authCookie());
    expect(res.status).toBe(403);
  });

  it('gathers unsettled charge-to-room orders across every Booking row sharing the external ID', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
    mockPrisma.booking.findFirst.mockResolvedValue({ id: 'booking_1', referenceNo: '83887', deletedAt: null });
    // A group checked in across two submissions under the same external
    // ID — booking_1 (the entry point) and booking_2 (a sibling).
    mockPrisma.booking.findMany.mockResolvedValue([{ id: 'booking_1' }, { id: 'booking_2' }]);
    mockPrisma.fnbOrder.findMany.mockResolvedValue([
      {
        id: 'fnb_1',
        referenceNo: 'FB-001',
        bookingId: 'booking_1',
        unit: { id: 'unit_1', code: 'R01', name: 'Room 1' },
        subtotal: 500,
        createdAt: new Date('2026-11-05T01:00:00.000Z'),
      },
      {
        id: 'fnb_2',
        referenceNo: 'FB-002',
        bookingId: 'booking_2', // the sibling's own order — must still be found
        unit: { id: 'unit_2', code: 'R02', name: 'Room 2' },
        subtotal: 300,
        createdAt: new Date('2026-11-05T02:00:00.000Z'),
      },
    ]);
    mockPrisma.folioCharge.findMany.mockResolvedValue([]); // nothing pulled in yet

    const res = await request(createApp()).get('/api/v1/bookings/booking_1/unsettled-fnb-charges').set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.charges).toHaveLength(2);
    expect(res.body.charges.map((c: { fnbOrderId: string }) => c.fnbOrderId)).toEqual(['fnb_1', 'fnb_2']);
    expect(mockPrisma.fnbOrder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ bookingId: { in: expect.arrayContaining(['booking_1', 'booking_2']) } }) }),
    );
  });

  it('excludes an order already pulled into a (non-voided) FolioCharge', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('CASHIER'));
    mockPrisma.booking.findFirst.mockResolvedValue({ id: 'booking_1', referenceNo: '83887', deletedAt: null });
    mockPrisma.booking.findMany.mockResolvedValue([{ id: 'booking_1' }]);
    mockPrisma.fnbOrder.findMany.mockResolvedValue([
      {
        id: 'fnb_1',
        referenceNo: 'FB-001',
        bookingId: 'booking_1',
        unit: { id: 'unit_1', code: 'R01', name: 'Room 1' },
        subtotal: 500,
        createdAt: new Date(),
      },
    ]);
    mockPrisma.folioCharge.findMany.mockResolvedValue([{ sourceId: 'fnb_1' }]);

    const res = await request(createApp()).get('/api/v1/bookings/booking_1/unsettled-fnb-charges').set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.charges).toEqual([]);
  });
});
