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
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Amenities' })).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('Kayak')).toBeInTheDocument());
    expect(screen.queryByText('Add an item')).not.toBeInTheDocument();
    expect(screen.queryByText('Deactivate')).not.toBeInTheDocument();
  });
});
