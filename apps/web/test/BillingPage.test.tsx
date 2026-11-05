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
  units: [{ id: 'bu_1', unitId: 'unit_1', releasedAt: null, unit: { id: 'unit_1', code: 'R01', name: 'Room 1', status: 'OCCUPIED' } }],
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
  lines: [],
  deductions: [],
  grandTotal: 0,
  totalDeductions: 0,
  totalAmountDue: 0,
};

const previewWithRoomCharge = {
  ...emptyPreview,
  lines: [{ description: 'R01 room charge', qty: 2, unitPrice: 1100, amount: 2200 }],
  grandTotal: 2200,
  totalAmountDue: 2200,
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
    await user.click(screen.getByRole('button', { name: 'Post room charge' }));
    await waitFor(() => expect(postedRoomCharge).toBe(true));
    await waitFor(() => expect(previewCallCount).toBe(2));
    await waitFor(() => expect(screen.getAllByText('₱2,200.00').length).toBeGreaterThan(0));

    // Issue.
    await user.type(screen.getByLabelText('Billing No.'), '83887');
    await user.type(screen.getByLabelText('Prepared by'), 'yssa');
    await user.click(screen.getByRole('button', { name: 'Issue receipt' }));

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Receipt issued' })).toBeInTheDocument());
    expect(screen.getByText('83887-11042026-01')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'ACKNOWLEDGEMENT RECEIPT' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Print' })).toBeInTheDocument();
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
