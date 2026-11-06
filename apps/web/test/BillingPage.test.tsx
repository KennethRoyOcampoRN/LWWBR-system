import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.js';

function jsonResponse(status: number, body: unknown) {
  return Promise.resolve({
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body),
  } as Response);
}

const cashierUser = {
  id: 'user_1',
  employeeCode: 'LWW-030',
  fullName: 'Cashier (Demo)',
  email: null,
  department: 'FRONT_OFFICE',
  mustChangePassword: false,
  roles: ['CASHIER'],
  permissions: { 'receipt:issue': 'ALL' },
};

const checkedInBooking = {
  id: 'booking_1',
  referenceNo: '83887',
  guestName: 'Roel Villagomez',
  status: 'CHECKED_IN',
  units: [
    {
      id: 'bu_1',
      unitId: 'unit_1',
      releasedAt: null,
      occupiedTo: '2026-11-12T00:00:00.000Z',
      unit: { id: 'unit_1', code: 'R01', name: 'Room 1', status: 'OCCUPIED', unitTypeName: 'Couple B' },
    },
  ],
};

const confirmedBooking = {
  ...checkedInBooking,
  status: 'CONFIRMED',
};

const emptyPreview = {
  resort: {
    name: 'Lucky Waku Waku Beach Resort',
    address: '225 Caisip Blvd, Phase 3, San Diego, Lian, Batangas',
    cellNo: '09668294198',
    contactNo: '043-726-7198',
    website: 'www.luckywakuwakubeachresort.com',
    facebookUrl: 'Lucky Waku Waku Beach Resort',
    logo: null,
  },
  guest: { name: 'Roel Villagomez', address: null, contactNo: null, email: null },
  lines: [] as { description: string; qty: number; unitPrice: number; amount: number }[],
  deductions: [] as { type: string; label: string; amount: number; sourcePaymentId?: string }[],
  grandTotal: 0,
  totalDeductions: 0,
  totalAmountDue: 0,
  outstandingBalance: 0,
};

const previewWithRoomCharge = {
  ...emptyPreview,
  lines: [{ description: 'R01 room charge', qty: 2, unitPrice: 1100, amount: 2200 }],
  grandTotal: 2200,
  totalAmountDue: 2200,
  outstandingBalance: 2200,
};

const issuedReceipt = {
  id: 'receipt_1',
  billingNumberFull: '83887-11042026-01',
  status: 'ISSUED',
  issuedAt: '2026-11-04T06:00:00.000Z',
  preparedByName: 'yssa',
  resort: emptyPreview.resort,
  guest: emptyPreview.guest,
  lines: [{ description: 'R01 room charge', qty: 2, unitPrice: 1100, amount: 2200 }],
  deductions: [],
  grandTotal: 2200,
  totalDeductions: 0,
  totalAmountDue: 2200,
  outstandingBalance: 2200,
};

describe('BillingPage', () => {
  // Re-plan, spec.md §13 decision 16: the folio is read-only here —
  // previewReceipt/issueReceipt build their lines from posted
  // FolioCharge rows, not a client-submitted array. Posting a room
  // charge (via the Rooms section's own button) is what makes the
  // preview non-empty, not typing a line directly.
  it('posts a room charge from the Rooms section, previews it, and issues a receipt — no client-typed lines anywhere', async () => {
    const user = userEvent.setup();
    let previewCallCount = 0;
    let postedRoomCharge = false;

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: cashierUser });
      if (url.endsWith('/units') && (!init || init.method === undefined)) return jsonResponse(200, { units: [] });
      if (url.endsWith('/bookings/booking_1') && !init?.method) return jsonResponse(200, { booking: checkedInBooking });
      if (url.endsWith('/bookings/booking_1/folio-charges') && (!init || init.method === undefined)) {
        return jsonResponse(200, { folioCharges: postedRoomCharge ? [{ id: 'charge_1', bookingId: 'booking_1', source: 'ROOM', description: 'R01 room charge', qty: 2, unitPrice: 1100, amount: 2200, status: 'POSTED' }] : [] });
      }
      if (url.endsWith('/bookings/booking_1/folio-charges') && init?.method === 'POST') {
        const body = JSON.parse(init.body as string);
        expect(body.source).toBe('ROOM');
        expect(body).not.toHaveProperty('unitPrice');
        expect(body).not.toHaveProperty('qty');
        // Item 4's fix: built from the unit and its type, not the old
        // hardcoded "{code} room charge".
        expect(body.description).toBe('Couple B (R01)');
        postedRoomCharge = true;
        return jsonResponse(201, { folioCharge: { id: 'charge_1', ...body } });
      }
      if (url.endsWith('/bookings/booking_1/unsettled-fnb-charges')) return jsonResponse(200, { charges: [] });
      if (url.endsWith('/bookings/booking_1/receipts/preview') && init?.method === 'POST') {
        previewCallCount += 1;
        return jsonResponse(200, postedRoomCharge ? previewWithRoomCharge : emptyPreview);
      }
      if (url.endsWith('/bookings/booking_1/receipts') && init?.method === 'POST') {
        return jsonResponse(201, { receipt: issuedReceipt });
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState({}, '', '/billing/booking_1');

    render(<App />);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Bill guest' })).toBeInTheDocument());
    await waitFor(() => expect(screen.getAllByText('Roel Villagomez').length).toBeGreaterThan(0));
    expect(previewCallCount).toBe(1);

    // Post the room charge — no unitPrice/qty field exists for this
    // action at all, since the server prices it automatically. Posting
    // auto-recomputes the preview (no separate "Update preview" click
    // needed).
    await user.click(screen.getByRole('button', { name: 'Charge room to folio' }));
    await waitFor(() => expect(postedRoomCharge).toBe(true));
    await waitFor(() => expect(previewCallCount).toBe(2));
    await waitFor(() => expect(screen.getAllByText('₱2,200.00').length).toBeGreaterThan(0));
    // Spec.md §13 decision 18: the running-balance line is a layout
    // addition to both the pre-issuance preview and the printed receipt.
    expect(screen.getAllByText('Running Balance').length).toBeGreaterThan(0);

    // Issue.
    await user.type(screen.getByLabelText('Billing No.'), '83887');
    await user.type(screen.getByLabelText('Prepared by'), 'yssa');
    await user.click(screen.getByRole('button', { name: 'Issue receipt' }));

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Receipt issued' })).toBeInTheDocument());
    expect(screen.getByText('83887-11042026-01')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'ACKNOWLEDGEMENT RECEIPT' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Print' })).toBeInTheDocument();
    expect(screen.getByText('Running Balance')).toBeInTheDocument();
  });

  // Bug caught in review, 2026-11-06 (spec.md §13 decision 16): a 422
  // from this action used to set chargeError, rendered in the Folio
  // section — but the trigger button lives in the Rooms section, which
  // renders roomActionError. The error was invisible where the cashier
  // was actually looking, so the button looked dead.
  it('shows a failed room-charge error in the Rooms section, not the Folio section', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: cashierUser });
      if (url.endsWith('/units') && (!init || init.method === undefined)) return jsonResponse(200, { units: [] });
      if (url.endsWith('/bookings/booking_1') && !init?.method) return jsonResponse(200, { booking: checkedInBooking });
      if (url.endsWith('/bookings/booking_1/folio-charges') && (!init || init.method === undefined)) {
        return jsonResponse(200, { folioCharges: [] });
      }
      if (url.endsWith('/bookings/booking_1/folio-charges') && init?.method === 'POST') {
        return jsonResponse(422, { error: { code: 'ROOM_CHECKOUT_DATE_REQUIRED', message: 'Supply a checkout date to price this room.' } });
      }
      if (url.endsWith('/bookings/booking_1/unsettled-fnb-charges')) return jsonResponse(200, { charges: [] });
      if (url.endsWith('/bookings/booking_1/receipts/preview') && init?.method === 'POST') {
        return jsonResponse(200, emptyPreview);
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState({}, '', '/billing/booking_1');

    render(<App />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Charge room to folio' })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Charge room to folio' }));

    const errorText = await screen.findByText('Supply a checkout date to price this room.');
    // The error renders inside the Rooms section (where "Move" lives),
    // not the Folio section (where "Post charge" lives).
    const roomsSection = screen.getByText('Move').closest('section');
    expect(roomsSection).toContainElement(errorText);
  });

  // Item 2's frontend coverage: a walk-up room (occupiedTo still null —
  // never priced) must show the checkout-date field, disable the
  // charge button until it's filled, and send it in the request body.
  it('shows a checkout-date field for a walk-up room (occupiedTo still null) and sends it when charging', async () => {
    const user = userEvent.setup();
    let postedBody: Record<string, unknown> | null = null;
    const walkUpBooking = {
      ...checkedInBooking,
      units: [
        {
          id: 'bu_1',
          unitId: 'unit_1',
          releasedAt: null,
          occupiedTo: null,
          unit: { id: 'unit_1', code: 'R01', name: 'Room 1', status: 'OCCUPIED', unitTypeName: 'Couple B' },
        },
      ],
    };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: cashierUser });
      if (url.endsWith('/units') && (!init || init.method === undefined)) return jsonResponse(200, { units: [] });
      if (url.endsWith('/bookings/booking_1') && !init?.method) return jsonResponse(200, { booking: walkUpBooking });
      if (url.endsWith('/bookings/booking_1/folio-charges') && (!init || init.method === undefined)) {
        return jsonResponse(200, { folioCharges: [] });
      }
      if (url.endsWith('/bookings/booking_1/folio-charges') && init?.method === 'POST') {
        postedBody = JSON.parse(init.body as string);
        return jsonResponse(201, { folioCharge: { id: 'charge_1', ...postedBody } });
      }
      if (url.endsWith('/bookings/booking_1/unsettled-fnb-charges')) return jsonResponse(200, { charges: [] });
      if (url.endsWith('/bookings/booking_1/receipts/preview') && init?.method === 'POST') {
        return jsonResponse(200, emptyPreview);
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState({}, '', '/billing/booking_1');

    render(<App />);

    await waitFor(() => expect(screen.getByLabelText('Checkout date (walk-up — not on file)')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Charge room to folio' })).toBeDisabled();

    await user.type(screen.getByLabelText('Checkout date (walk-up — not on file)'), '2026-11-12');
    expect(screen.getByRole('button', { name: 'Charge room to folio' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Charge room to folio' }));

    await waitFor(() => expect(postedBody).toMatchObject({ checkOutDate: '2026-11-12' }));
  });

  it('on a duplicate-billing-number warning, confirming reissues with confirmDuplicateBillingNumber: true', async () => {
    const user = userEvent.setup();
    let issueCallCount = 0;
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: cashierUser });
      if (url.endsWith('/units') && (!init || init.method === undefined)) return jsonResponse(200, { units: [] });
      if (url.endsWith('/bookings/booking_1') && !init?.method) return jsonResponse(200, { booking: checkedInBooking });
      if (url.endsWith('/bookings/booking_1/folio-charges') && (!init || init.method === undefined)) {
        return jsonResponse(200, { folioCharges: [{ id: 'charge_1', bookingId: 'booking_1', source: 'ROOM', description: 'R01 room charge', qty: 2, unitPrice: 1100, amount: 2200, status: 'POSTED' }] });
      }
      if (url.endsWith('/bookings/booking_1/unsettled-fnb-charges')) return jsonResponse(200, { charges: [] });
      if (url.endsWith('/bookings/booking_1/receipts/preview') && init?.method === 'POST') {
        return jsonResponse(200, previewWithRoomCharge);
      }
      if (url.endsWith('/bookings/booking_1/receipts') && init?.method === 'POST') {
        issueCallCount += 1;
        const body = JSON.parse(init.body as string);
        if (!body.confirmDuplicateBillingNumber) {
          return jsonResponse(409, {
            error: {
              code: 'DUPLICATE_BILLING_NUMBER',
              message: 'This billing number was already used today for a different booking. Confirm to issue it anyway.',
            },
          });
        }
        return jsonResponse(201, { receipt: issuedReceipt });
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState({}, '', '/billing/booking_1');

    render(<App />);

    await waitFor(() => expect(screen.getAllByText('Roel Villagomez').length).toBeGreaterThan(0));
    await user.type(screen.getByLabelText('Billing No.'), '83887');
    await user.type(screen.getByLabelText('Prepared by'), 'yssa');
    await user.click(screen.getByRole('button', { name: 'Issue receipt' }));

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Receipt issued' })).toBeInTheDocument());
    expect(issueCallCount).toBe(2);
    expect(window.confirm).toHaveBeenCalled();
  });

  // Re-plan, spec.md §13 decision 16: a CONFIRMED (pre-arrival) booking
  // can be resolved — the guest checks in, cancels, or never shows.
  it('shows resolve actions for a CONFIRMED booking, and calls /resolve with the chosen status', async () => {
    const user = userEvent.setup();
    let resolveBody: Record<string, unknown> | null = null;

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: cashierUser });
      if (url.endsWith('/units') && (!init || init.method === undefined)) return jsonResponse(200, { units: [] });
      if (url.endsWith('/bookings/booking_1') && !init?.method) return jsonResponse(200, { booking: confirmedBooking });
      if (url.endsWith('/bookings/booking_1/folio-charges') && (!init || init.method === undefined)) {
        return jsonResponse(200, { folioCharges: [] });
      }
      if (url.endsWith('/bookings/booking_1/unsettled-fnb-charges')) return jsonResponse(200, { charges: [] });
      if (url.endsWith('/bookings/booking_1/receipts/preview') && init?.method === 'POST') {
        return jsonResponse(200, emptyPreview);
      }
      if (url.endsWith('/bookings/booking_1/resolve') && init?.method === 'POST') {
        resolveBody = JSON.parse(init.body as string);
        return jsonResponse(200, { booking: { ...confirmedBooking, status: 'CHECKED_IN' } });
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState({}, '', '/billing/booking_1');

    render(<App />);

    await waitFor(() => expect(screen.getByText('Booked (not arrived)')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Guest checked in' }));

    await waitFor(() => expect(resolveBody).toEqual({ toStatus: 'CHECKED_IN' }));
  });

  // Spec.md §13 decision 17 (2026-11-06): cashier-editable amounts with
  // a required-reason confirm dialog, surfaced as an "Overridden" badge.
  it('overrides a folio charge amount via the confirm dialog, and shows the overridden badge', async () => {
    const user = userEvent.setup();
    let overridden = false;
    let overrideBody: Record<string, unknown> | null = null;

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: cashierUser });
      if (url.endsWith('/units') && (!init || init.method === undefined)) return jsonResponse(200, { units: [] });
      if (url.endsWith('/bookings/booking_1') && !init?.method) return jsonResponse(200, { booking: checkedInBooking });
      if (url.endsWith('/bookings/booking_1/folio-charges') && (!init || init.method === undefined)) {
        return jsonResponse(200, {
          folioCharges: [
            {
              id: 'charge_1',
              bookingId: 'booking_1',
              source: 'ROOM',
              description: 'R01 room charge',
              qty: 2,
              unitPrice: 1100,
              amount: 2200,
              status: 'POSTED',
              overrides: overridden
                ? [{ id: 'override_1', previousUnitPrice: 1100, previousAmount: 2200, newUnitPrice: 1000, newAmount: 2000, reason: 'Loyalty discount', overriddenAt: '2026-11-06T01:00:00.000Z' }]
                : [],
            },
          ],
        });
      }
      if (url.endsWith('/folio-charges/charge_1/override') && init?.method === 'POST') {
        overrideBody = JSON.parse(init.body as string);
        overridden = true;
        return jsonResponse(200, { folioCharge: { id: 'charge_1', unitPrice: 1000, amount: 2000 } });
      }
      if (url.endsWith('/bookings/booking_1/unsettled-fnb-charges')) return jsonResponse(200, { charges: [] });
      if (url.endsWith('/bookings/booking_1/receipts/preview') && init?.method === 'POST') {
        return jsonResponse(200, previewWithRoomCharge);
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState({}, '', '/billing/booking_1');

    render(<App />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Override amount' })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Override amount' }));

    const reasonField = await screen.findByLabelText('Reason');
    await user.type(reasonField, 'Loyalty discount');
    const newPriceField = screen.getByLabelText('New price');
    await user.clear(newPriceField);
    await user.type(newPriceField, '1000');
    await user.click(screen.getByRole('button', { name: 'Confirm override' }));

    await waitFor(() => expect(overrideBody).toMatchObject({ newUnitPrice: 1000, reason: 'Loyalty discount' }));
    // Desktop table and mobile card both render (only CSS toggles which
    // is visible in a real browser — see DataTable.tsx's own comment).
    await waitFor(() => expect(screen.getAllByText(/Overridden \(was ₱2,200\.00\)/).length).toBeGreaterThan(0));
  });

  // Spec.md §13 decision 17: a draft deduction is edited in place behind
  // a confirm-dialog-with-required-reason UX, no persisted audit table.
  it('edits a draft deduction in place, requiring a reason', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: cashierUser });
      if (url.endsWith('/units') && (!init || init.method === undefined)) return jsonResponse(200, { units: [] });
      if (url.endsWith('/bookings/booking_1') && !init?.method) return jsonResponse(200, { booking: checkedInBooking });
      if (url.endsWith('/bookings/booking_1/folio-charges') && (!init || init.method === undefined)) {
        return jsonResponse(200, { folioCharges: [] });
      }
      if (url.endsWith('/bookings/booking_1/unsettled-fnb-charges')) return jsonResponse(200, { charges: [] });
      if (url.endsWith('/bookings/booking_1/receipts/preview') && init?.method === 'POST') {
        return jsonResponse(200, emptyPreview);
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState({}, '', '/billing/booking_1');

    render(<App />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Add deduction' })).toBeInTheDocument());
    // Add a deduction through the ordinary form first — there is no
    // server-side draft-deduction entity, only this page's own local
    // state, so the edit flow under test needs a row to act on.
    await user.type(screen.getByLabelText('Label'), 'Downpayment');
    // "Amount" is now ambiguous with the Payments section's own record-
    // payment form (decision 19) — the Deductions form's field is the
    // second one in DOM order (Payments renders above Deductions).
    await user.type(screen.getAllByLabelText('Amount')[1]!, '500');
    await user.click(screen.getByRole('button', { name: 'Add deduction' }));

    await waitFor(() => expect(screen.getAllByText(/-₱500\.00/).length).toBeGreaterThan(0));
    await user.click(screen.getAllByRole('button', { name: 'Edit' })[0]!);

    // "Amount"/"Label" are now ambiguous with the Payments section's own
    // record-payment form (decision 19) and the still-visible "Add
    // deduction" form below — in DOM order that's [Payments, edit
    // dialog, Add-deduction form], so the edit dialog's own field is
    // the second one.
    const amountField = (await screen.findAllByLabelText('Amount'))[1]!;
    await user.clear(amountField);
    await user.type(amountField, '600');
    // Save is a no-op without a reason — the confirm-dialog-with-
    // required-reason UX decision 17 asked for.
    await user.click(screen.getAllByRole('button', { name: 'Save' })[0]!);
    expect((await screen.findAllByLabelText('Amount'))[1]).toBeInTheDocument(); // dialog still open, nothing committed

    await user.type(screen.getByLabelText('Reason'), 'Guest requested a larger downpayment');
    await user.click(screen.getAllByRole('button', { name: 'Save' })[0]!);

    await waitFor(() => expect(screen.getAllByText(/-₱600\.00/).length).toBeGreaterThan(0));
  });

  // Spec.md §13 decision 19 (2026-11-06): the client went looking for
  // where to enter cash and found nothing — decision 18's entire
  // backend (CASH-immediate, the derived DOWNPAYMENT deduction,
  // outstandingBalance) was unreachable without this section. Full
  // path: record cash, confirm the balance drops immediately and the
  // deduction appears unrequested; record GCash, confirm it does
  // neither until verified.
  it('records a cash payment (effective immediately, derived deduction, balance drops) vs. a GCash payment (awaits verification, no effect)', async () => {
    const user = userEvent.setup();
    let payments: Record<string, unknown>[] = [];
    let preview = previewWithRoomCharge;
    let postedPaymentBody: Record<string, unknown> | null = null;

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: cashierUser });
      if (url.endsWith('/units') && (!init || init.method === undefined)) return jsonResponse(200, { units: [] });
      if (url.endsWith('/bookings/booking_1') && !init?.method) return jsonResponse(200, { booking: checkedInBooking });
      if (url.endsWith('/bookings/booking_1/folio-charges') && (!init || init.method === undefined)) {
        return jsonResponse(200, {
          folioCharges: [
            { id: 'charge_1', bookingId: 'booking_1', source: 'ROOM', sourceId: 'bu_1', description: 'R01 room charge', qty: 2, unitPrice: 1100, amount: 2200, status: 'POSTED', overrides: [] },
          ],
        });
      }
      if (url.endsWith('/bookings/booking_1/unsettled-fnb-charges')) return jsonResponse(200, { charges: [] });
      if (url.endsWith('/bookings/booking_1/payments') && (!init || init.method === undefined)) {
        return jsonResponse(200, { payments });
      }
      if (url.endsWith('/bookings/booking_1/payments') && init?.method === 'POST') {
        const body = JSON.parse(init.body as string) as Record<string, unknown>;
        postedPaymentBody = body;
        const method = body.method as string;
        payments = [
          ...payments,
          {
            id: `payment_${payments.length + 1}`,
            amount: body.amount,
            method,
            kind: body.kind,
            referenceNo: body.referenceNo ?? null,
            status: 'PENDING',
            submittedAt: '2026-11-06T01:00:00.000Z',
            submittedBy: { fullName: 'Cashier (Demo)' },
          },
        ];
        // Only a CASH payment moves the balance/derives a deduction —
        // a GCash one stays PENDING with no effect until verified.
        if (method === 'CASH') {
          preview = {
            ...previewWithRoomCharge,
            deductions: [{ type: 'DOWNPAYMENT', label: 'Payment received (Cash)', amount: 500, sourcePaymentId: 'payment_1' }],
            totalDeductions: 500,
            totalAmountDue: 1700,
            outstandingBalance: 1700,
          };
        }
        return jsonResponse(201, { payment: payments[payments.length - 1] });
      }
      if (url.endsWith('/bookings/booking_1/receipts/preview') && init?.method === 'POST') {
        return jsonResponse(200, preview);
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState({}, '', '/billing/booking_1');

    render(<App />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Record payment' })).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('Outstanding balance: ₱2,200.00')).toBeInTheDocument());

    // Record cash. "Amount" is ambiguous with the Deductions section's
    // own field further down the page — Payments renders first.
    await user.type(screen.getAllByLabelText('Amount')[0]!, '500');
    await user.click(screen.getByRole('button', { name: 'Record payment' }));

    await waitFor(() => expect(postedPaymentBody).toMatchObject({ amount: 500, method: 'CASH' }));
    // DataTable renders both a desktop table and a mobile card list
    // (only CSS toggles which is visible — see DataTable.tsx's own
    // comment), so matching text appears twice in jsdom.
    await waitFor(() => expect(screen.getAllByText('Effective immediately (cash)').length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.getByText('Outstanding balance: ₱1,700.00')).toBeInTheDocument());
    // The derived deduction appears without being typed, marked automatic.
    await waitFor(() => expect(screen.getByText('Payment received (Cash)')).toBeInTheDocument());
    expect(screen.getByText('Automatic — from a recorded payment, not editable')).toBeInTheDocument();

    // Record GCash — shows up, but neither moves the balance nor
    // derives a deduction, since it isn't CASH and isn't VERIFIED.
    postedPaymentBody = null;
    await user.selectOptions(screen.getByLabelText('Method'), 'GCASH');
    await user.clear(screen.getAllByLabelText('Amount')[0]!);
    await user.type(screen.getAllByLabelText('Amount')[0]!, '1000');
    await user.click(screen.getByRole('button', { name: 'Record payment' }));

    await waitFor(() => expect(postedPaymentBody).toMatchObject({ amount: 1000, method: 'GCASH' }));
    await waitFor(() => expect(screen.getAllByText('Awaiting verification — not yet applied').length).toBeGreaterThan(0));
    // Balance and deduction are unchanged from the cash-only state above.
    expect(screen.getByText('Outstanding balance: ₱1,700.00')).toBeInTheDocument();
  });

  // Spec.md §13 decision 19 (2026-11-06): the client's actual scenario
  // — a double-posted room charge, undone by the cashier who made the
  // mistake, seconds later, with no manager needed.
  // Spec.md §13 decision 21 (2026-11-06): client's own words — "the
  // purpose of delete is for errors, don't make it hard to delete
  // errors." A never-receipted charge shows Delete, not Void, and
  // deleting it needs no reason.
  it('shows Delete (not Void) for a never-receipted charge, and deletes it with a plain confirm', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    let charges = [
      { id: 'charge_1', bookingId: 'booking_1', source: 'MISC', sourceId: null, description: 'Lost key fob', qty: 1, unitPrice: 500, amount: 500, status: 'POSTED', overrides: [], hasBeenReceipted: false },
    ];
    let deleted = false;

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: cashierUser });
      if (url.endsWith('/units') && (!init || init.method === undefined)) return jsonResponse(200, { units: [] });
      if (url.endsWith('/bookings/booking_1') && !init?.method) return jsonResponse(200, { booking: checkedInBooking });
      if (url.endsWith('/bookings/booking_1/folio-charges') && (!init || init.method === undefined)) {
        return jsonResponse(200, { folioCharges: deleted ? [] : charges });
      }
      if (url.endsWith('/bookings/booking_1/unsettled-fnb-charges')) return jsonResponse(200, { charges: [] });
      if (url.endsWith('/bookings/booking_1/payments') && (!init || init.method === undefined)) return jsonResponse(200, { payments: [] });
      if (url.endsWith('/bookings/booking_1/receipts') && (!init || init.method === undefined)) return jsonResponse(200, { receipts: [] });
      if (url.endsWith('/bookings/booking_1/receipts/preview') && init?.method === 'POST') return jsonResponse(200, emptyPreview);
      if (url.endsWith('/folio-charges/charge_1') && init?.method === 'DELETE') {
        deleted = true;
        return jsonResponse(204, {});
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState({}, '', '/billing/booking_1');

    render(<App />);

    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Delete' }).length).toBeGreaterThan(0));
    expect(screen.queryByRole('button', { name: 'Void' })).not.toBeInTheDocument();

    await user.click(screen.getAllByRole('button', { name: 'Delete' })[0]!);

    expect(window.confirm).toHaveBeenCalled();
    await waitFor(() => expect(deleted).toBe(true));
    await waitFor(() => expect(screen.getByText('No charges posted yet.')).toBeInTheDocument());
  });

  it('shows an already-charged room as a toggle, and reverting it voids the charge', async () => {
    const user = userEvent.setup();
    let charges: Record<string, unknown>[] = [
      { id: 'charge_1', bookingId: 'booking_1', source: 'ROOM', sourceId: 'bu_1', description: 'R01 room charge', qty: 2, unitPrice: 1100, amount: 2200, status: 'POSTED', overrides: [] },
    ];
    let voidedBody: Record<string, unknown> | null = null;

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: cashierUser });
      if (url.endsWith('/units') && (!init || init.method === undefined)) return jsonResponse(200, { units: [] });
      if (url.endsWith('/bookings/booking_1') && !init?.method) return jsonResponse(200, { booking: checkedInBooking });
      if (url.endsWith('/bookings/booking_1/folio-charges') && (!init || init.method === undefined)) {
        return jsonResponse(200, { folioCharges: charges });
      }
      if (url.endsWith('/bookings/booking_1/unsettled-fnb-charges')) return jsonResponse(200, { charges: [] });
      if (url.endsWith('/bookings/booking_1/payments') && (!init || init.method === undefined)) return jsonResponse(200, { payments: [] });
      if (url.endsWith('/bookings/booking_1/receipts/preview') && init?.method === 'POST') return jsonResponse(200, previewWithRoomCharge);
      if (url.endsWith('/folio-charges/charge_1/void') && init?.method === 'POST') {
        voidedBody = JSON.parse(init.body as string);
        charges = [{ ...charges[0]!, status: 'VOIDED' }];
        return jsonResponse(200, { folioCharge: charges[0] });
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState({}, '', '/billing/booking_1');

    render(<App />);

    await waitFor(() => expect(screen.getByText(/Charged to folio/)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Charge room to folio' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Revert' }));
    await user.type(screen.getByLabelText('Reason'), 'Double-posted by mistake');
    await user.click(screen.getByRole('button', { name: 'Confirm revert' }));

    await waitFor(() => expect(voidedBody).toEqual({ voidReason: 'Double-posted by mistake' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Charge room to folio' })).toBeInTheDocument());
    // Spec.md §13 decision 21: voided charges default to hidden in the
    // Folio table — "Show voided charges" reveals them.
    expect(screen.queryByText('Voided')).not.toBeInTheDocument();
    await user.click(screen.getByLabelText('Show voided charges'));
    await waitFor(() => expect(screen.getAllByText('Voided').length).toBeGreaterThan(0));
  });

  // Spec.md §13 decision 20 (2026-11-06): POST /receipts/:id/void had no
  // caller anywhere in the frontend — a receipt issued in error was
  // permanent, and under decision 18's incremental model, voiding is
  // what releases its charges back for re-billing.
  it('lists past receipts and voids one, requiring a reason', async () => {
    const user = userEvent.setup();
    let receiptStatus = 'ISSUED';
    let voidedBody: Record<string, unknown> | null = null;
    const pastReceipt = { ...issuedReceipt };

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: cashierUser });
      if (url.endsWith('/units') && (!init || init.method === undefined)) return jsonResponse(200, { units: [] });
      if (url.endsWith('/bookings/booking_1') && !init?.method) return jsonResponse(200, { booking: checkedInBooking });
      if (url.endsWith('/bookings/booking_1/folio-charges') && (!init || init.method === undefined)) {
        return jsonResponse(200, { folioCharges: [] });
      }
      if (url.endsWith('/bookings/booking_1/unsettled-fnb-charges')) return jsonResponse(200, { charges: [] });
      if (url.endsWith('/bookings/booking_1/payments') && (!init || init.method === undefined)) return jsonResponse(200, { payments: [] });
      if (url.endsWith('/bookings/booking_1/receipts') && (!init || init.method === undefined)) {
        return jsonResponse(200, { receipts: [{ ...pastReceipt, status: receiptStatus }] });
      }
      if (url.endsWith('/bookings/booking_1/receipts/preview') && init?.method === 'POST') return jsonResponse(200, emptyPreview);
      if (url.endsWith('/receipts/receipt_1/void') && init?.method === 'POST') {
        voidedBody = JSON.parse(init.body as string);
        receiptStatus = 'VOIDED';
        return jsonResponse(200, { receipt: { ...pastReceipt, status: 'VOIDED' } });
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState({}, '', '/billing/booking_1');

    render(<App />);

    await waitFor(() => expect(screen.getAllByText('83887-11042026-01').length).toBeGreaterThan(0));
    await user.click(screen.getAllByRole('button', { name: 'Void' })[0]!);
    await user.type(screen.getByLabelText('Reason'), 'Issued with the wrong billing number');
    await user.click(screen.getByRole('button', { name: 'Confirm void' }));

    await waitFor(() => expect(voidedBody).toEqual({ voidReason: 'Issued with the wrong billing number' }));
    await waitFor(() => expect(screen.getAllByText('VOIDED').length).toBeGreaterThan(0));
    expect(screen.queryByRole('button', { name: 'Void' })).not.toBeInTheDocument();
  });

  // Spec.md §13 decision 20 (2026-11-06): GET /receipts/:id had no
  // caller either — the Past Receipts table only ever showed summary
  // columns, with no way to see or reprint the full issued document.
  it('views a past receipt via the Past Receipts table, labelled "Receipt" not "Receipt issued"', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: cashierUser });
      if (url.endsWith('/units') && (!init || init.method === undefined)) return jsonResponse(200, { units: [] });
      if (url.endsWith('/bookings/booking_1') && !init?.method) return jsonResponse(200, { booking: checkedInBooking });
      if (url.endsWith('/bookings/booking_1/folio-charges') && (!init || init.method === undefined)) {
        return jsonResponse(200, { folioCharges: [] });
      }
      if (url.endsWith('/bookings/booking_1/unsettled-fnb-charges')) return jsonResponse(200, { charges: [] });
      if (url.endsWith('/bookings/booking_1/payments') && (!init || init.method === undefined)) return jsonResponse(200, { payments: [] });
      if (url.endsWith('/bookings/booking_1/receipts') && (!init || init.method === undefined)) {
        return jsonResponse(200, { receipts: [issuedReceipt] });
      }
      if (url.endsWith('/bookings/booking_1/receipts/preview') && init?.method === 'POST') return jsonResponse(200, emptyPreview);
      if (url.endsWith('/receipts/receipt_1') && (!init || init.method === undefined)) {
        return jsonResponse(200, { receipt: issuedReceipt });
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState({}, '', '/billing/booking_1');

    render(<App />);

    await waitFor(() => expect(screen.getAllByRole('button', { name: 'View' }).length).toBeGreaterThan(0));
    await user.click(screen.getAllByRole('button', { name: 'View' })[0]!);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Receipt' })).toBeInTheDocument());
    expect(screen.queryByRole('heading', { name: 'Receipt issued' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back to billing' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Back to billing' }));
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'View' }).length).toBeGreaterThan(0));
  });

  it('a non-receipt:issue holder does not see the page', async () => {
    const otherUser = { ...cashierUser, roles: ['HOUSEKEEPING_STAFF'], permissions: { 'unit:read': 'ALL' } };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: otherUser });
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState({}, '', '/billing/booking_1');

    render(<App />);

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent("You don't have permission"));
  });
});
