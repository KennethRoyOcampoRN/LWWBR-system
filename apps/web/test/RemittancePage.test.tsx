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

const adminStaffUser = {
  id: 'user_1',
  employeeCode: 'LWW-020',
  fullName: 'Admin Staff (Demo)',
  email: null,
  department: 'FRONT_OFFICE',
  mustChangePassword: false,
  roles: ['ADMIN_STAFF'],
  permissions: { 'remittance:create': 'ALL', 'remittance:read': 'ALL' },
};

const ownerUser = {
  id: 'user_2',
  employeeCode: 'LWW-001',
  fullName: 'Owner (Demo)',
  email: null,
  department: 'MANAGEMENT',
  mustChangePassword: false,
  roles: ['OWNER'],
  permissions: { 'remittance:read': 'ALL', 'remittance:verify': 'ALL' },
};

const remittanceRequest = {
  id: 'remit_1',
  referenceNo: 'RM-260831-0001',
  name: 'Juan Dela Cruz',
  date: '2026-08-30T00:00:00.000Z',
  modeOfPayment: 'GCash',
  amount: 5000,
  referenceNumber: 'GC-123456789',
  status: 'FOR_VERIFICATION',
  proofFile: null,
  createdBy: { fullName: 'Admin Staff (Demo)' },
  verifiedBy: null,
};

describe('RemittancePage', () => {
  it('an ADMIN_STAFF holder can list and submit a payment for verification, with no verify controls', async () => {
    const user = userEvent.setup();
    let requests: Record<string, unknown>[] = [];

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: adminStaffUser });
      if (url.endsWith('/remittance-requests') && (!init || init.method === undefined)) {
        return jsonResponse(200, { remittanceRequests: requests });
      }
      if (url.endsWith('/remittance-requests') && init?.method === 'POST') {
        const body = JSON.parse(init.body as string);
        expect(body).toMatchObject({
          name: 'Juan Dela Cruz',
          modeOfPayment: 'GCash',
          amount: 5000,
          referenceNumber: 'GC-123456789',
        });
        const created = { ...remittanceRequest };
        requests = [created];
        return jsonResponse(201, { remittanceRequest: created });
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState({}, '', '/payment-verification');

    render(<App />);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Payment Verification' })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Mark verified' })).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('Name'), 'Juan Dela Cruz');
    await user.type(screen.getByLabelText('Date'), '2026-08-30');
    await user.type(screen.getByLabelText('Mode of payment'), 'GCash');
    await user.type(screen.getByLabelText('Amount (₱)'), '5000');
    await user.type(screen.getByLabelText('Reference number'), 'GC-123456789');
    await user.click(screen.getByRole('button', { name: 'Submit for verification' }));

    await waitFor(() => expect(screen.getByText('RM-260831-0001')).toBeInTheDocument());
    expect(screen.getByText('For verification')).toBeInTheDocument();
  });

  it('a non-creator holder with only remittance:read sees no create form', async () => {
    const readOnlyUser = { ...adminStaffUser, permissions: { 'remittance:read': 'ALL' } };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: readOnlyUser });
      if (url.endsWith('/remittance-requests')) return jsonResponse(200, { remittanceRequests: [remittanceRequest] });
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState({}, '', '/payment-verification');

    render(<App />);

    await waitFor(() => expect(screen.getByText('RM-260831-0001')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Submit for verification' })).not.toBeInTheDocument();
  });

  it('OWNER sees Verify controls and can mark a request VERIFIED, then revert it back', async () => {
    const user = userEvent.setup();
    let requests = [remittanceRequest];

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: ownerUser });
      if (url.endsWith('/remittance-requests') && (!init || init.method === undefined)) {
        return jsonResponse(200, { remittanceRequests: requests });
      }
      if (url.match(/\/remittance-requests\/remit_1\/status$/) && init?.method === 'POST') {
        const body = JSON.parse(init.body as string);
        const updated = { ...requests[0]!, status: body.toStatus };
        requests = [updated];
        return jsonResponse(200, { remittanceRequest: updated });
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState({}, '', '/payment-verification');

    render(<App />);

    await waitFor(() => expect(screen.getByText('RM-260831-0001')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Submit for verification' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Mark verified' }));
    await waitFor(() => expect(screen.getByText('Verified')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Revert to for verification' }));
    await waitFor(() => expect(screen.getByText('For verification')).toBeInTheDocument());
  });
});
