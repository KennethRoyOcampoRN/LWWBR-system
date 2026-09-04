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

const stockManagerUser = {
  id: 'user_1',
  employeeCode: 'LWW-030',
  fullName: 'Stock Manager (Demo)',
  email: null,
  department: 'FRONT_OFFICE',
  mustChangePassword: false,
  roles: ['STOCK_MANAGER'],
  permissions: { 'stock:read': 'ALL', 'stock:manage': 'ALL', 'stock:log_movement': 'ALL' },
};

const stockItem = {
  id: 'stock_1',
  name: 'Toilet Paper (12-roll pack)',
  category: 'CLEANING',
  unitOfMeasure: 'pack',
  currentQty: 20,
  reorderLevel: 10,
  isActive: true,
};

describe('StockPage', () => {
  it('a STOCK_MANAGER holder can list items, add a catalog item, and log a movement', async () => {
    const user = userEvent.setup();
    let items = [stockItem];

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: stockManagerUser });
      if (url.endsWith('/stock-items') && (!init || init.method === undefined)) {
        return jsonResponse(200, { stockItems: items });
      }
      if (url.endsWith('/stock-items') && init?.method === 'POST') {
        const body = JSON.parse(init.body as string);
        expect(body).toMatchObject({ name: 'Dish Soap', category: 'KITCHEN', unitOfMeasure: 'bottle', reorderLevel: 5 });
        const created = { id: 'stock_2', ...body, currentQty: body.initialQty ?? 0, isActive: true };
        items = [...items, created];
        return jsonResponse(201, { stockItem: created });
      }
      if (url.endsWith('/stock-items/stock_1/movements') && init?.method === 'POST') {
        const body = JSON.parse(init.body as string);
        expect(body).toMatchObject({ reason: 'RECEIVE', quantity: 10 });
        items = [{ ...items[0]!, currentQty: 30 }];
        return jsonResponse(201, { stockMovement: { id: 'move_1', stockItemId: 'stock_1', delta: 10, reason: 'RECEIVE' } });
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState({}, '', '/stock');

    render(<App />);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Stock' })).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('Toilet Paper (12-roll pack)')).toBeInTheDocument());

    // Log a movement on the existing item. Once the form opens there are
    // two "Log movement" buttons — the row trigger and the form's own
    // submit button — so disambiguate by position.
    await user.click(screen.getAllByRole('button', { name: 'Log movement' })[0]!);
    await user.type(screen.getByLabelText('Quantity'), '10');
    const logButtons = screen.getAllByRole('button', { name: 'Log movement' });
    await user.click(logButtons[logButtons.length - 1]!);
    await waitFor(() => expect(screen.getByText('30')).toBeInTheDocument());

    // Add a new catalog item.
    await user.type(screen.getByLabelText('Name'), 'Dish Soap');
    await user.selectOptions(screen.getByLabelText('Category'), 'KITCHEN');
    await user.type(screen.getByLabelText('Unit of measure'), 'bottle');
    await user.type(screen.getByLabelText('Reorder threshold'), '5');
    await user.click(screen.getByRole('button', { name: 'Add item' }));

    await waitFor(() => expect(screen.getByText('Dish Soap')).toBeInTheDocument());
  });

  it('a read-only holder (stock:read only) sees the catalog but no add-item form or movement/deactivate controls', async () => {
    const readOnlyUser = { ...stockManagerUser, permissions: { 'stock:read': 'ALL' } };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: readOnlyUser });
      if (url.endsWith('/stock-items')) return jsonResponse(200, { stockItems: [stockItem] });
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState({}, '', '/stock');

    render(<App />);

    await waitFor(() => expect(screen.getByText('Toilet Paper (12-roll pack)')).toBeInTheDocument());
    expect(screen.queryByText('Add an item')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Log movement' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Deactivate' })).not.toBeInTheDocument();
  });

  it('a viewer with no stock:* access at all does not see the Stock nav item or page', async () => {
    const noStockUser = { ...stockManagerUser, roles: ['RESORT_STAFF'], permissions: { 'unit:read': 'ALL' } };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: noStockUser });
      if (url.includes('/units/dashboard')) {
        return jsonResponse(200, {
          kpi: {
            occupied: 0, ready: 0, dirty: 0, outOfOrder: 0, urgentOpenWorkOrders: 0,
            checkinsToday: 0, checkoutsToday: 0, openFnbOrders: 0, lowStockItems: 0,
          },
          dirtyRooms: [], slaBreachedWorkOrders: [], overdueAmenityRequests: [], lowStockItems: [],
        });
      }
      if (url.includes('/units/activity')) return jsonResponse(200, { events: [] });
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState({}, '', '/');

    render(<App />);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Command Center' })).toBeInTheDocument());
    expect(screen.queryByRole('link', { name: 'Stock' })).not.toBeInTheDocument();
  });
});
