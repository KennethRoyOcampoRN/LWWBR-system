import { render, screen, waitFor, within } from '@testing-library/react';
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

const issuedReceipt = {
  id: 'receipt_1',
  billingNumberFull: '83887-11042026-01',
  status: 'ISSUED',
  issuedAt: '2026-11-04T06:00:00.000Z',
  preparedByName: 'yssa',
  resort: emptyPreview.resort,
  guest: emptyPreview.guest,
  lines: [{ description: 'COUPLE B - BALI', qty: 1, unitPrice: 1100, amount: 1100 }],
  deductions: [],
  grandTotal: 1100,
  totalDeductions: 0,
  totalAmountDue: 1100,
};

describe('BillingPage', () => {
  it('previews on load, adds a line, updates the preview, and issues a receipt', async () => {
    const user = userEvent.setup();
    let previewCallCount = 0;

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: cashierUser });
      if (url.endsWith('/unit-types')) return jsonResponse(200, { unitTypes: [] });
      if (url.endsWith('/bookings/booking_1/receipts/preview') && init?.method === 'POST') {
        previewCallCount += 1;
        const body = JSON.parse(init.body as string);
        if (body.lines.length === 0) return jsonResponse(200, emptyPreview);
        return jsonResponse(200, { ...emptyPreview, lines: body.lines.map((l: { description: string; qty: number; unitPrice: number }) => ({ ...l, amount: l.qty * l.unitPrice })), grandTotal: 1100, totalAmountDue: 1100 });
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
    await waitFor(() => expect(screen.getByText('Roel Villagomez')).toBeInTheDocument());
    expect(previewCallCount).toBe(1);

    // Add a line manually.
    await user.type(screen.getByLabelText('Description'), 'COUPLE B - BALI');
    await user.clear(screen.getByLabelText('Quantity/Days'));
    await user.type(screen.getByLabelText('Quantity/Days'), '1');
    await user.type(screen.getByLabelText('Price'), '1100');
    await user.click(screen.getByRole('button', { name: 'Add line' }));

    const lineTable = screen.getByRole('table');
    await waitFor(() => expect(within(lineTable).getByText('COUPLE B - BALI')).toBeInTheDocument());

    // Recompute the preview with the new line.
    await user.click(screen.getByRole('button', { name: 'Update preview' }));
    await waitFor(() => expect(previewCallCount).toBe(2));
    // Appears more than once (the line's own Total cell, desktop and
    // mobile DataTable renders, and the Grand Total/Total Amount Due
    // rows) — any match proves the preview recomputed and rendered.
    await waitFor(() => expect(screen.getAllByText('₱1,100.00').length).toBeGreaterThan(0));

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
      if (url.endsWith('/unit-types')) return jsonResponse(200, { unitTypes: [] });
      if (url.endsWith('/bookings/booking_1/receipts/preview') && init?.method === 'POST') {
        return jsonResponse(200, emptyPreview);
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

    await waitFor(() => expect(screen.getByText('Roel Villagomez')).toBeInTheDocument());
    await user.type(screen.getByLabelText('Description'), 'Room');
    await user.clear(screen.getByLabelText('Quantity/Days'));
    await user.type(screen.getByLabelText('Quantity/Days'), '1');
    await user.type(screen.getByLabelText('Price'), '100');
    await user.click(screen.getByRole('button', { name: 'Add line' }));

    await user.type(screen.getByLabelText('Billing No.'), '83887');
    await user.type(screen.getByLabelText('Prepared by'), 'yssa');
    await user.click(screen.getByRole('button', { name: 'Issue receipt' }));

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Receipt issued' })).toBeInTheDocument());
    expect(issueCallCount).toBe(2);
    expect(window.confirm).toHaveBeenCalled();
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
