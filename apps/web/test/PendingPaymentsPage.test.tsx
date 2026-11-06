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

const managerUser = {
  id: 'user_1',
  employeeCode: 'LWW-001',
  fullName: 'Resort Manager (Demo)',
  email: null,
  department: 'MANAGEMENT',
  mustChangePassword: false,
  roles: ['RESORT_MANAGER'],
  permissions: { 'payment:verify': 'ALL' },
};

const pendingPayment = {
  id: 'payment_1',
  amount: 1000,
  method: 'GCASH',
  referenceNo: 'GC-12345',
  status: 'PENDING',
  submittedAt: '2026-11-06T01:00:00.000Z',
  submittedBy: { fullName: 'Yssa (Cashier)' },
  verifiedBy: null,
  rejectionReason: null,
  booking: { referenceNo: '83887', guestName: 'Roel Villagomez' },
};

// Spec.md §13 decision 20 (2026-11-06): without this page,
// GET/POST /payments/:id/status had no caller, so GCash/bank/card/
// other payments could never be verified — permanently stuck at
// PENDING, never reducing a booking's balance.
describe('PendingPaymentsPage', () => {
  it('lists a pending GCash payment and verifies it', async () => {
    const user = userEvent.setup();
    let payments = [pendingPayment];
    let statusBody: Record<string, unknown> | null = null;

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: managerUser });
      if (url.includes('/payments?status=PENDING') && (!init || init.method === undefined)) {
        return jsonResponse(200, { payments });
      }
      if (url.endsWith('/payments/payment_1/status') && init?.method === 'POST') {
        const body = JSON.parse(init.body as string) as Record<string, unknown>;
        statusBody = body;
        payments = [];
        return jsonResponse(200, { payment: { ...pendingPayment, status: body.toStatus } });
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState({}, '', '/payments');

    render(<App />);

    // DataTable renders both a desktop table and a mobile card list —
    // only CSS toggles which is visible (see DataTable.tsx's own
    // comment) — so matching text appears twice in jsdom.
    await waitFor(() => expect(screen.getAllByText('Roel Villagomez (83887)').length).toBeGreaterThan(0));
    expect(screen.getAllByText('GCash').length).toBeGreaterThan(0);
    expect(screen.getAllByText('GC-12345').length).toBeGreaterThan(0);

    await user.click(screen.getAllByRole('button', { name: 'Verify' })[0]!);

    await waitFor(() => expect(statusBody).toEqual({ toStatus: 'VERIFIED' }));
    await waitFor(() => expect(screen.getByText('Nothing awaiting verification.')).toBeInTheDocument());
  });

  it('rejects a payment, requiring a reason', async () => {
    const user = userEvent.setup();
    let payments = [pendingPayment];
    let statusBody: Record<string, unknown> | null = null;

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: managerUser });
      if (url.includes('/payments?status=PENDING') && (!init || init.method === undefined)) {
        return jsonResponse(200, { payments });
      }
      if (url.endsWith('/payments/payment_1/status') && init?.method === 'POST') {
        statusBody = JSON.parse(init.body as string);
        payments = [];
        return jsonResponse(200, { payment: { ...pendingPayment, status: 'REJECTED' } });
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState({}, '', '/payments');

    render(<App />);

    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Reject' })[0]).toBeInTheDocument());
    await user.click(screen.getAllByRole('button', { name: 'Reject' })[0]!);

    // No-op without a reason.
    await user.click(screen.getByRole('button', { name: 'Confirm reject' }));
    expect(statusBody).toBeNull();

    await user.type(screen.getByLabelText('Rejection reason'), 'Reference number does not match any GCash receipt');
    await user.click(screen.getByRole('button', { name: 'Confirm reject' }));

    await waitFor(() =>
      expect(statusBody).toEqual({ toStatus: 'REJECTED', rejectionReason: 'Reference number does not match any GCash receipt' }),
    );
  });

  it('a holder without payment:verify does not see the page', async () => {
    const cashierUser = { ...managerUser, roles: ['CASHIER'], permissions: { 'receipt:issue': 'ALL' } };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: cashierUser });
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState({}, '', '/payments');

    render(<App />);

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent("You don't have permission"));
  });
});
