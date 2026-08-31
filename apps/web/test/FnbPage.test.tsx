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

const restaurantManagerUser = {
  id: 'user_1',
  employeeCode: 'LWW-014',
  fullName: 'Restaurant Manager (Demo)',
  email: null,
  department: 'RESTAURANT',
  mustChangePassword: false,
  roles: ['RESTAURANT_MANAGER'],
  permissions: { 'fnb:read': 'ALL', 'fnb:manage_menu': 'ALL' },
};

const restaurantStaffUser = {
  ...restaurantManagerUser,
  id: 'user_2',
  fullName: 'Restaurant Staff (Demo)',
  roles: ['RESTAURANT_STAFF'],
  permissions: { 'fnb:read': 'ALL' },
};

// Real gap fixed alongside the Command Center KPI-card-navigation slice
// (2026-08-31): OWNER held zero fnb:* keys at all — added fnb:read only,
// so this is exactly OWNER's real post-fix permission shape (same shape
// as restaurantStaffUser above, named for what's actually under test
// below: that fnb:read alone, with none of the three write keys, drives
// FnbPage.tsx's own canManageMenu/canCreateOrder/canUpdateOrderStatus
// gates to false everywhere without anything crashing).
const ownerUser = {
  ...restaurantManagerUser,
  id: 'user_4',
  fullName: 'Owner (Demo)',
  roles: ['OWNER'],
  permissions: { 'fnb:read': 'ALL' },
};

// Holds every fnb:* capability so one test can drive order placement
// through the full kanban lifecycle without switching users (matches
// SYSTEM_ADMIN/RESORT_MANAGER-with-Restaurant-Staff-hat holding all of
// these together in practice).
const fullAccessUser = {
  ...restaurantManagerUser,
  id: 'user_3',
  permissions: { 'fnb:read': 'ALL', 'fnb:manage_menu': 'ALL', 'fnb:create': 'ALL', 'fnb:update_status': 'ALL' },
};

const sisig = {
  id: 'menu_1',
  name: 'Sisig',
  category: 'Main',
  price: 250,
  isAvailable: true,
  prepMinutes: 15,
  sortOrder: 0,
};

describe('FnbPage', () => {
  beforeEach(() => {
    window.history.pushState({}, '', '/restaurant');
  });

  it('a manage-menu holder can list and add a menu item', async () => {
    const user = userEvent.setup();
    let items = [sisig];

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: restaurantManagerUser });
      if (url.endsWith('/menu-items') && (!init || init.method === undefined)) {
        return jsonResponse(200, { menuItems: items });
      }
      if (url.endsWith('/menu-items') && init?.method === 'POST') {
        const body = JSON.parse(init.body as string);
        expect(body).toMatchObject({ name: 'Halo-halo', category: 'Dessert', price: 120 });
        const created = { id: 'menu_2', ...body, isAvailable: true, sortOrder: 0, prepMinutes: undefined };
        items = [...items, created];
        return jsonResponse(201, { menuItem: created });
      }
      if (url.includes('/fnb-orders')) return jsonResponse(200, { fnbOrders: [] });
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Restaurant' })).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('Sisig')).toBeInTheDocument());
    expect(screen.getByText('₱250.00')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Name'), 'Halo-halo');
    await user.type(screen.getByLabelText('Category'), 'Dessert');
    await user.clear(screen.getByLabelText('Price (₱)'));
    await user.type(screen.getByLabelText('Price (₱)'), '120');
    await user.click(screen.getByRole('button', { name: 'Add menu item' }));

    await waitFor(() => expect(screen.getByText('Halo-halo')).toBeInTheDocument());
  });

  it('toggles a menu item unavailable', async () => {
    const user = userEvent.setup();
    let items = [sisig];

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: restaurantManagerUser });
      if (url.endsWith('/menu-items') && (!init || init.method === undefined)) {
        return jsonResponse(200, { menuItems: items });
      }
      if (url.endsWith('/menu-items/menu_1') && init?.method === 'PATCH') {
        const body = JSON.parse(init.body as string);
        items = [{ ...items[0]!, ...body }];
        return jsonResponse(200, { menuItem: items[0] });
      }
      if (url.includes('/fnb-orders')) return jsonResponse(200, { fnbOrders: [] });
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => expect(screen.getByText('Sisig')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Mark unavailable' }));
    await waitFor(() => expect(screen.getByText('Unavailable')).toBeInTheDocument());
  });

  it('a read-only holder sees the menu but no "Add a menu item" form', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: restaurantStaffUser });
      if (url.endsWith('/menu-items')) return jsonResponse(200, { menuItems: [sisig] });
      if (url.includes('/fnb-orders')) return jsonResponse(200, { fnbOrders: [] });
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => expect(screen.getByText('Sisig')).toBeInTheDocument());
    expect(screen.queryByText('Add a menu item')).not.toBeInTheDocument();
    expect(screen.queryByText('Mark unavailable')).not.toBeInTheDocument();
  });

  // Real gap fixed alongside this slice: OWNER now holds fnb:read (see
  // rolePermissions.ts) and can reach this page at all for the first
  // time. Confirms the read-only view is correct, not just that the
  // permission object has the right key — a populated kitchen board (a
  // real RECEIVED ticket) and populated menu, and asserts every write
  // control's absence directly (not present anywhere in the DOM), not
  // merely that the read-only content still renders around them.
  it('OWNER (fnb:read only) sees a fully read-only view — no status buttons, no order form, no menu edit controls', async () => {
    const receivedOrder = {
      id: 'order_1',
      referenceNo: 'FB-260824-0001',
      unit: { id: 'unit_1', code: 'R01', name: 'Room 1' },
      guestName: null,
      type: 'DINE_IN',
      scheduledFor: null,
      settlement: 'PAY_NOW',
      status: 'RECEIVED',
      subtotal: 500,
      notes: null,
      createdAt: new Date().toISOString(),
      createdBy: { fullName: 'Restaurant Manager (Demo)' },
      lines: [{ id: 'line_1', menuItemId: 'menu_1', qty: 2, unitPrice: 250, notes: null, itemName: 'Sisig', menuItem: { id: 'menu_1', name: 'Sisig' } }],
    };

    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: ownerUser });
      if (url.endsWith('/menu-items')) return jsonResponse(200, { menuItems: [sisig] });
      if (url.includes('/fnb-orders?history=true')) return jsonResponse(200, { fnbOrders: [] });
      if (url.includes('/fnb-orders?boardOnly=true')) return jsonResponse(200, { fnbOrders: [receivedOrder] });
      if (url.includes('/fnb-orders')) return jsonResponse(200, { fnbOrders: [receivedOrder] });
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Restaurant' })).toBeInTheDocument());

    // Read-only content renders: the real ticket and the real menu item
    // are visible, not an empty or broken page.
    await waitFor(() => expect(screen.getByText('FB-260824-0001')).toBeInTheDocument());
    expect(screen.getByText('Received (1)')).toBeInTheDocument();
    expect(screen.getAllByText('Sisig').length).toBeGreaterThan(0);
    expect(screen.getByText('₱250.00')).toBeInTheDocument();

    // Kitchen board: no status-change controls on the ticket at all.
    expect(screen.queryByRole('button', { name: 'Start preparing' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();

    // No order-placement form anywhere on the page.
    expect(screen.queryByText('Place an order')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Place order' })).not.toBeInTheDocument();

    // Menu: no edit controls on the existing item, no add-item form.
    expect(screen.queryByRole('button', { name: 'Mark unavailable' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    expect(screen.queryByText('Add a menu item')).not.toBeInTheDocument();
  });

  it('drives an order through place -> start preparing -> mark ready -> mark served', async () => {
    const user = userEvent.setup();
    let fnbOrders: Record<string, unknown>[] = [];

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: fullAccessUser });
      if (url.endsWith('/menu-items')) return jsonResponse(200, { menuItems: [sisig] });
      if (url.endsWith('/units/orderable')) {
        return jsonResponse(200, { units: [{ id: 'unit_1', code: 'R01', name: 'Room 1', status: 'OCCUPIED' }] });
      }
      if (url.includes('/fnb-orders') && (!init || init.method === undefined)) {
        return jsonResponse(200, { fnbOrders });
      }
      if (url.endsWith('/fnb-orders') && init?.method === 'POST') {
        const body = JSON.parse(init.body as string);
        expect(body).toMatchObject({ type: 'DINE_IN', settlement: 'PAY_NOW', lines: [{ menuItemId: 'menu_1', qty: 2 }] });
        const created = {
          id: 'order_1',
          referenceNo: 'FB-260824-0001',
          unit: null,
          guestName: null,
          type: 'DINE_IN',
          scheduledFor: null,
          settlement: 'PAY_NOW',
          status: 'RECEIVED',
          subtotal: 500,
          notes: null,
          createdAt: new Date().toISOString(),
          createdBy: { fullName: 'Restaurant Manager (Demo)' },
          lines: [{ id: 'line_1', menuItemId: 'menu_1', qty: 2, unitPrice: 250, notes: null, itemName: 'Sisig', menuItem: { id: 'menu_1', name: 'Sisig' } }],
        };
        fnbOrders = [created];
        return jsonResponse(201, { fnbOrder: created });
      }
      if (url.match(/\/fnb-orders\/order_1\/status$/) && init?.method === 'POST') {
        const body = JSON.parse(init.body as string);
        const current = fnbOrders[0] as Record<string, unknown>;
        const updated = { ...current, status: body.toStatus };
        fnbOrders = [updated];
        return jsonResponse(200, { fnbOrder: updated });
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Restaurant' })).toBeInTheDocument());
    await waitFor(() => expect(screen.getAllByText('Sisig').length).toBeGreaterThan(0));

    await user.selectOptions(screen.getByRole('combobox', { name: /^Type$/ }), 'DINE_IN');
    // Select the menu item on the order line (the only <select> without an
    // accessible name is the line's own menu-item picker).
    const lineSelect = screen.getAllByRole('combobox').find((el) => el.textContent?.includes('Select an item'));
    await user.selectOptions(lineSelect!, 'menu_1');
    const qtyInput = screen.getAllByRole('spinbutton').find((el) => (el as HTMLInputElement).value === '1')!;
    await user.clear(qtyInput);
    await user.type(qtyInput, '2');
    await user.click(screen.getByRole('button', { name: 'Place order' }));

    await waitFor(() => expect(screen.getByText('FB-260824-0001')).toBeInTheDocument());
    expect(screen.getByText('Received (1)')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Start preparing' }));
    await waitFor(() => expect(screen.getByText('Preparing (1)')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Mark ready' }));
    await waitFor(() => expect(screen.getByText('Ready (1)')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Mark served' }));
    // SERVED drops off the active board — none of the three columns show it anymore.
    await waitFor(() => expect(screen.queryByText('FB-260824-0001')).not.toBeInTheDocument());
  });

  it('cancelling an order requires a reason and shows it in order history', async () => {
    const user = userEvent.setup();
    const receivedOrder = {
      id: 'order_1',
      referenceNo: 'FB-260824-0001',
      unit: null,
      guestName: null,
      type: 'DINE_IN',
      scheduledFor: null,
      settlement: 'PAY_NOW',
      status: 'RECEIVED',
      subtotal: 500,
      notes: null,
      createdAt: new Date().toISOString(),
      createdBy: { fullName: 'Restaurant Manager (Demo)' },
      cancelReason: null,
      cancelledBy: null,
      cancelledAt: null,
      lines: [{ id: 'line_1', menuItemId: 'menu_1', qty: 2, unitPrice: 250, notes: null, itemName: 'Sisig', menuItem: { id: 'menu_1', name: 'Sisig' } }],
    };
    let fnbOrders: Record<string, unknown>[] = [receivedOrder];
    let historyOrders: Record<string, unknown>[] = [];

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: fullAccessUser });
      if (url.endsWith('/menu-items')) return jsonResponse(200, { menuItems: [sisig] });
      if (url.endsWith('/units/orderable')) return jsonResponse(200, { units: [] });
      if (url.includes('/fnb-orders?history=true')) return jsonResponse(200, { fnbOrders: historyOrders });
      if (url.includes('/fnb-orders?boardOnly=true')) return jsonResponse(200, { fnbOrders });
      if (url.match(/\/fnb-orders\/order_1\/status$/) && init?.method === 'POST') {
        const body = JSON.parse(init.body as string);
        expect(body).toMatchObject({ toStatus: 'CANCELLED', cancelReason: 'Guest left early' });
        const updated = {
          ...receivedOrder,
          status: 'CANCELLED',
          cancelReason: body.cancelReason,
          cancelledBy: { fullName: 'Restaurant Manager (Demo)' },
          cancelledAt: new Date().toISOString(),
        };
        fnbOrders = [];
        historyOrders = [updated];
        return jsonResponse(200, { fnbOrder: updated });
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => expect(screen.getByText('FB-260824-0001')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Confirm cancel' }));
    await waitFor(() => expect(screen.getByText('A cancellation reason is required.')).toBeInTheDocument());

    await user.type(screen.getByLabelText('Cancellation reason (required)'), 'Guest left early');
    await user.click(screen.getByRole('button', { name: 'Confirm cancel' }));

    await waitFor(() => expect(screen.getByText('Order history')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText(/Guest left early/)).toBeInTheDocument());
  });

  // Client decision, 2026-08-25 (Option B): Delete is only offered once
  // a menu item is unavailable, and confirms before actually deleting.
  it('deletes an unavailable menu item after confirmation', async () => {
    const user = userEvent.setup();
    let items = [{ ...sisig, isAvailable: false }];
    let deleteCalled = false;

    vi.spyOn(window, 'confirm').mockReturnValue(true);

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: restaurantManagerUser });
      if (url.endsWith('/menu-items')) return jsonResponse(200, { menuItems: items });
      if (url.includes('/fnb-orders')) return jsonResponse(200, { fnbOrders: [] });
      if (url.endsWith('/menu-items/menu_1') && init?.method === 'DELETE') {
        deleteCalled = true;
        items = [];
        return jsonResponse(204, undefined);
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => expect(screen.getByText('Sisig')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(deleteCalled).toBe(true));
    await waitFor(() => expect(screen.queryByText('Sisig')).not.toBeInTheDocument());
  });
});
