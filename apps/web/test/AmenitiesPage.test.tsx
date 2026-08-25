import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  employeeCode: 'LWW-003',
  fullName: 'Resort Manager (Demo)',
  email: null,
  department: 'MANAGEMENT',
  mustChangePassword: false,
  roles: ['RESORT_MANAGER'],
  permissions: { 'amenity:read': 'ALL', 'amenity:manage': 'ALL' },
};

const readOnlyUser = {
  ...managerUser,
  id: 'user_2',
  fullName: 'Admin Staff (Demo)',
  roles: ['ADMIN_STAFF'],
  permissions: { 'amenity:read': 'ALL' },
};

// Holds every amenity:* capability so one test can drive the full
// request -> approve -> issue -> return lifecycle without switching users
// (matches SYSTEM_ADMIN/RESORT_MANAGER holding all of them in the real
// seed — see rolePermissions.ts).
const fullAccessUser = {
  ...managerUser,
  id: 'user_3',
  fullName: 'Resort Manager (Demo)',
  permissions: {
    'amenity:read': 'ALL',
    'amenity:manage': 'ALL',
    'amenity:request': 'ALL',
    'amenity:approve': 'ALL',
    'amenity:issue': 'ALL',
    'amenity:return': 'ALL',
  },
};

const kayak = {
  id: 'amenity_1',
  name: 'Kayak',
  category: 'OUTDOOR',
  assetTag: null,
  totalQty: 2,
  condition: 'Good',
  requiresDeposit: true,
  depositAmount: 1000,
  isActive: true,
};

describe('AmenitiesPage', () => {
  beforeEach(() => {
    window.history.pushState({}, '', '/amenities');
  });

  it('a manage-permission holder can list and add an amenity item, deposit shown as informational text only', async () => {
    const user = userEvent.setup();
    let items = [kayak];

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: managerUser });
      if (url.endsWith('/amenity-items') && (!init || init.method === undefined)) {
        return jsonResponse(200, { amenityItems: items });
      }
      if (url.endsWith('/amenity-items') && init?.method === 'POST') {
        const body = JSON.parse(init.body as string);
        expect(body).toMatchObject({ name: 'Frisbee', category: 'OUTDOOR', totalQty: 3, requiresDeposit: false });
        const created = { id: 'amenity_2', ...body, assetTag: null, depositAmount: 0, isActive: true };
        items = [...items, created];
        return jsonResponse(201, { amenityItem: created });
      }
      if (url.endsWith('/amenity-requests')) return jsonResponse(200, { amenityRequests: [] });
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Amenities' })).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('Kayak')).toBeInTheDocument());
    // Deposit renders as plain informational text, not a Payment/Folio UI.
    expect(screen.getByText('₱1,000.00')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Name'), 'Frisbee');
    await user.selectOptions(screen.getByLabelText('Category'), 'OUTDOOR');
    await user.clear(screen.getByLabelText('Total quantity'));
    await user.type(screen.getByLabelText('Total quantity'), '3');
    await user.clear(screen.getByLabelText('Condition'));
    await user.type(screen.getByLabelText('Condition'), 'New');
    await user.click(screen.getByRole('button', { name: 'Add item' }));

    await waitFor(() => expect(screen.getByText('Frisbee')).toBeInTheDocument());
  });

  it('a read-only holder sees the catalogue but no "Add an item" form', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: readOnlyUser });
      if (url.endsWith('/amenity-items')) return jsonResponse(200, { amenityItems: [kayak] });
      if (url.endsWith('/amenity-requests')) return jsonResponse(200, { amenityRequests: [] });
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Amenities' })).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('Kayak')).toBeInTheDocument());
    expect(screen.queryByText('Add an item')).not.toBeInTheDocument();
    expect(screen.queryByText('Deactivate')).not.toBeInTheDocument();
  });

  it('drives a request through approve -> issue (deposit gate) -> return', async () => {
    const user = userEvent.setup();
    let amenityRequests: Record<string, unknown>[] = [];

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: fullAccessUser });
      if (url.endsWith('/amenity-items')) return jsonResponse(200, { amenityItems: [kayak] });

      if (url.endsWith('/amenity-requests') && (!init || init.method === undefined)) {
        return jsonResponse(200, { amenityRequests });
      }
      if (url.endsWith('/amenity-requests') && init?.method === 'POST') {
        const body = JSON.parse(init.body as string);
        expect(body).toMatchObject({ amenityItemId: 'amenity_1', qty: 1 });
        const created = {
          id: 'request_1',
          referenceNo: 'AR-260824-0001',
          qty: 1,
          status: 'REQUESTED',
          dueBackAt: null,
          notes: null,
          amenityItem: { id: 'amenity_1', name: 'Kayak', requiresDeposit: true, depositAmount: 1000 },
          requestedBy: { fullName: 'Resort Manager (Demo)' },
        };
        amenityRequests = [created];
        return jsonResponse(201, { amenityRequest: created });
      }
      if (url.match(/\/amenity-requests\/request_1\/status$/) && init?.method === 'POST') {
        const body = JSON.parse(init.body as string);
        const current = amenityRequests[0] as Record<string, unknown>;
        if (body.toStatus === 'ISSUED') {
          // The deposit gate: the component must not even attempt the
          // request until depositCollected is confirmed client-side —
          // but assert defensively here too, since the real backend gate
          // is the actual enforcement point.
          expect(body.depositCollected).toBe(true);
          expect(body.dueBackAt).toBeTruthy();
        }
        const updated = { ...current, status: body.toStatus, dueBackAt: body.dueBackAt ?? current.dueBackAt };
        amenityRequests = [updated];
        return jsonResponse(200, { amenityRequest: updated });
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Amenities' })).toBeInTheDocument());
    await waitFor(() => expect(screen.getAllByText('Kayak').length).toBeGreaterThan(0));

    // Submit the request.
    await user.selectOptions(screen.getByLabelText('Item'), 'amenity_1');
    await user.click(screen.getByRole('button', { name: 'Submit request' }));
    await waitFor(() => expect(screen.getByText('AR-260824-0001')).toBeInTheDocument());
    expect(screen.getByText('Requested')).toBeInTheDocument();

    // Approve it.
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(screen.getByText('Approved')).toBeInTheDocument());

    // Open the Issue panel — confirm deposit is required for this item.
    await user.click(screen.getByRole('button', { name: 'Issue' }));
    await user.click(screen.getByRole('button', { name: 'Confirm issue' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/due-back/i);

    await user.type(screen.getByLabelText('Due back'), '2026-09-01T10:00');
    await user.click(screen.getByRole('button', { name: 'Confirm issue' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/deposit/i);

    await user.click(screen.getByLabelText(/Deposit collected/));
    await user.click(screen.getByRole('button', { name: 'Confirm issue' }));
    await waitFor(() => expect(screen.getByText('Issued')).toBeInTheDocument());

    // Return it.
    await user.click(screen.getByRole('button', { name: 'Return' }));
    await user.click(screen.getByRole('button', { name: 'Confirm returned' }));
    await waitFor(() => expect(screen.getByText('Returned')).toBeInTheDocument());
  });

  // Real gap found live-testing, 2026-08-25: totalQty was captured on
  // creation but an existing item had no way to edit it at all — only
  // Deactivate/Reactivate existed. This drives the new inline edit form.
  it('edits an existing item, including totalQty', async () => {
    const user = userEvent.setup();
    let items = [kayak];

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: managerUser });
      if (url.endsWith('/amenity-items') && (!init || init.method === undefined)) {
        return jsonResponse(200, { amenityItems: items });
      }
      if (url.endsWith('/amenity-requests')) return jsonResponse(200, { amenityRequests: [] });
      if (url.endsWith('/amenity-items/amenity_1') && init?.method === 'PATCH') {
        const body = JSON.parse(init.body as string);
        expect(body).toMatchObject({ totalQty: 5 });
        items = [{ ...items[0]!, ...body }];
        return jsonResponse(200, { amenityItem: items[0] });
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Amenities' })).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('Kayak')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    // Two "Total quantity" fields now exist (the edit row + the always-
    // present "Add an item" form below it) — the edit row's is first.
    const qtyInput = screen.getAllByLabelText('Total quantity')[0]!;
    expect(qtyInput).toHaveValue(2); // pre-filled from the existing item
    await user.clear(qtyInput);
    await user.type(qtyInput, '5');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(screen.getByRole('cell', { name: '5' })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
  });
});
