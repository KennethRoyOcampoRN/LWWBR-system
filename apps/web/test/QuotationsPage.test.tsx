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

const resortManagerUser = {
  id: 'user_1',
  employeeCode: 'LWW-003',
  fullName: 'Resort Manager (Demo)',
  email: null,
  department: 'MANAGEMENT',
  mustChangePassword: false,
  roles: ['RESORT_MANAGER'],
  permissions: { 'quotation:create': 'ALL', 'quotation:read': 'ALL' },
};

const systemAdminUser = {
  id: 'user_2',
  employeeCode: 'LWW-002',
  fullName: 'System Admin (Demo)',
  email: null,
  department: 'MANAGEMENT',
  mustChangePassword: false,
  roles: ['SYSTEM_ADMIN'],
  permissions: { 'quotation:read': 'ALL', 'quotation:update_status': 'ALL' },
};

const quotation = {
  id: 'quote_1',
  referenceNo: 'QT-260831-0001',
  name: 'Maria Santos',
  contactNumber: '09171234567',
  email: 'maria@example.com',
  pax: 4,
  checkInDate: '2026-09-10T00:00:00.000Z',
  checkOutDate: '2026-09-12T00:00:00.000Z',
  note: null,
  status: 'PENDING',
  createdBy: { fullName: 'Resort Manager (Demo)' },
};

describe('QuotationsPage', () => {
  it('a RESORT_MANAGER holder can list and submit a quotation request, with no status controls', async () => {
    const user = userEvent.setup();
    let requests: Record<string, unknown>[] = [];

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: resortManagerUser });
      if (url.endsWith('/quotation-requests') && (!init || init.method === undefined)) {
        return jsonResponse(200, { quotationRequests: requests });
      }
      if (url.endsWith('/quotation-requests') && init?.method === 'POST') {
        const body = JSON.parse(init.body as string);
        expect(body).toMatchObject({
          name: 'Maria Santos',
          contactNumber: '09171234567',
          email: 'maria@example.com',
          pax: 4,
        });
        const created = { ...quotation };
        requests = [created];
        return jsonResponse(201, { quotationRequest: created });
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState({}, '', '/quotations');

    render(<App />);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Quotations' })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Mark done' })).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('Name'), 'Maria Santos');
    await user.type(screen.getByLabelText('Contact number'), '09171234567');
    await user.type(screen.getByLabelText('Email'), 'maria@example.com');
    await user.type(screen.getByLabelText('Pax'), '4');
    await user.type(screen.getByLabelText('Check-in date'), '2026-09-10');
    await user.type(screen.getByLabelText('Check-out date'), '2026-09-12');
    await user.click(screen.getByRole('button', { name: 'Submit request' }));

    await waitFor(() => expect(screen.getByText('QT-260831-0001')).toBeInTheDocument());
    expect(screen.getByText('Pending')).toBeInTheDocument();
  });

  it('SYSTEM_ADMIN — explicitly excluded from quotation:create — sees no create form', async () => {
    const readOnlySystemAdmin = { ...systemAdminUser, permissions: { 'quotation:read': 'ALL' } };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: readOnlySystemAdmin });
      if (url.endsWith('/quotation-requests')) return jsonResponse(200, { quotationRequests: [quotation] });
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState({}, '', '/quotations');

    render(<App />);

    await waitFor(() => expect(screen.getByText('QT-260831-0001')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Submit request' })).not.toBeInTheDocument();
  });

  it('SYSTEM_ADMIN sees Done/Pending controls and can mark a quotation DONE, then revert it back', async () => {
    const user = userEvent.setup();
    let requests = [quotation];

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: systemAdminUser });
      if (url.endsWith('/quotation-requests') && (!init || init.method === undefined)) {
        return jsonResponse(200, { quotationRequests: requests });
      }
      if (url.match(/\/quotation-requests\/quote_1\/status$/) && init?.method === 'POST') {
        const body = JSON.parse(init.body as string);
        const updated = { ...requests[0]!, status: body.toStatus };
        requests = [updated];
        return jsonResponse(200, { quotationRequest: updated });
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState({}, '', '/quotations');

    render(<App />);

    await waitFor(() => expect(screen.getByText('QT-260831-0001')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Submit request' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Mark done' }));
    await waitFor(() => expect(screen.getByText('Done')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Revert to pending' }));
    await waitFor(() => expect(screen.getByText('Pending')).toBeInTheDocument());
  });

  it('a non-SYSTEM_ADMIN creator role (RESORT_MANAGER) sees no Done/Pending controls', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: resortManagerUser });
      if (url.endsWith('/quotation-requests')) return jsonResponse(200, { quotationRequests: [quotation] });
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState({}, '', '/quotations');

    render(<App />);

    await waitFor(() => expect(screen.getByText('QT-260831-0001')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Mark done' })).not.toBeInTheDocument();
  });
});
