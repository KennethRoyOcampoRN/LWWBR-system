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

const dashboardPayload = {
  kpi: {
    occupied: 0, ready: 0, dirty: 0, outOfOrder: 0, urgentOpenWorkOrders: 0,
    checkinsToday: 0, checkoutsToday: 0, openFnbOrders: 0, lowStockItems: 0,
  },
  dirtyRooms: [], slaBreachedWorkOrders: [], overdueAmenityRequests: [], lowStockItems: [],
};

// Visual redesign, step 1 (client-directed, 2026-11-xx): converted to
// DataTable, which renders every row twice in the DOM — a real <table>
// (visible from md up) and a stacked-card <ul> (visible below md),
// switched by CSS alone (see DataTable.tsx's own comment for why: same
// approach as AppShell's mobile nav, CSS-only responsive switching has
// no effect in jsdom, so both sides are always present for a test to
// see). Assertions about catalog *row* content below are scoped to
// `within(screen.getByRole('table'))` so they check the one real table,
// not "whichever of the two matches came first" — a bare `getByText`
// would throw on finding the same text twice. Assertions about the
// movement/add-item *forms* are unaffected, since those render once.
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
    // Every action below re-fetches the catalog, which cycles DataTable
    // through its loading skeleton — a different <table> element each
    // time, not the same one updated in place. `getTable()` is called
    // fresh right before each use, rather than a `table` reference
    // captured once, so each assertion/interaction sees the current
    // post-load table instead of a stale, now-detached one.
    const getTable = () => screen.getByRole('table');
    await waitFor(() => expect(within(getTable()).getByText('Toilet Paper (12-roll pack)')).toBeInTheDocument());

    // Open the movement form from the table row (the mobile card below
    // md also has its own "Log movement" button, same action — the
    // table is the one scoped here since it's guaranteed to be exactly
    // one match).
    await user.click(within(getTable()).getByRole('button', { name: 'Log movement' }));
    const movementForm = screen.getByRole('form', { name: 'Log movement' });
    await user.type(within(movementForm).getByLabelText('Quantity'), '10');
    await user.click(within(movementForm).getByRole('button', { name: 'Log movement' }));
    await waitFor(() => expect(within(getTable()).getByText('30')).toBeInTheDocument());

    // Add a new catalog item.
    const addForm = screen.getByRole('form', { name: 'Add an item' });
    await user.type(within(addForm).getByLabelText('Name'), 'Dish Soap');
    await user.selectOptions(within(addForm).getByLabelText('Category'), 'KITCHEN');
    await user.type(within(addForm).getByLabelText('Unit of measure'), 'bottle');
    await user.type(within(addForm).getByLabelText('Reorder threshold'), '5');
    await user.click(within(addForm).getByRole('button', { name: 'Add item' }));

    await waitFor(() => expect(within(getTable()).getByText('Dish Soap')).toBeInTheDocument());
  });

  // Client decision, 2026-09-11, same "Option B" convention as Amenities/
  // F&B's own menu-item delete: Delete is only offered once an item is
  // already inactive, and confirms before actually deleting.
  it('offers Delete only once an item is deactivated, and deletes it on confirmation', async () => {
    const user = userEvent.setup();
    let items = [stockItem];
    let deleteCalled = false;
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: stockManagerUser });
      if (url.endsWith('/stock-items') && (!init || init.method === undefined)) {
        return jsonResponse(200, { stockItems: items });
      }
      if (url.endsWith('/stock-items/stock_1') && init?.method === 'PATCH') {
        const body = JSON.parse(init.body as string);
        expect(body).toMatchObject({ isActive: false });
        items = [{ ...items[0]!, isActive: false }];
        return jsonResponse(200, { stockItem: items[0] });
      }
      if (url.endsWith('/stock-items/stock_1') && init?.method === 'DELETE') {
        deleteCalled = true;
        items = [];
        return jsonResponse(204, undefined);
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState({}, '', '/stock');

    render(<App />);

    // Same re-fetch-remounts-the-table caveat as the test above.
    const getTable = () => screen.getByRole('table');
    await screen.findByRole('table');
    await waitFor(() => expect(within(getTable()).getByText('Toilet Paper (12-roll pack)')).toBeInTheDocument());
    // Active item: no Delete button yet.
    expect(within(getTable()).queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();

    await user.click(within(getTable()).getByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(within(getTable()).getByRole('button', { name: 'Delete' })).toBeInTheDocument());

    await user.click(within(getTable()).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(deleteCalled).toBe(true));
    // The catalog is empty now — DataTable renders its EmptyState
    // instead of a table at all, so there's no more duplicate source
    // and a bare, unscoped query is safe here.
    await waitFor(() => expect(screen.queryByText('Toilet Paper (12-roll pack)')).not.toBeInTheDocument());
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

    await screen.findByRole('table');
    await waitFor(() => expect(within(screen.getByRole('table')).getByText('Toilet Paper (12-roll pack)')).toBeInTheDocument());
    expect(screen.queryByText('Add an item')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Log movement' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Deactivate' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  // Client follow-up, 2026-09-11: view-only stock:read added to
  // SYSTEM_ADMIN/OWNER/RESORT_MANAGER — deliberately NOT stock:manage or
  // stock:log_movement, which stay STOCK_MANAGER-only. Same standard as
  // the FnbPage OWNER test: real populated data (two items, one below
  // its reorder threshold), and every write control's absence asserted
  // directly in the DOM, not inferred from the permission object.
  it.each(['SYSTEM_ADMIN', 'OWNER', 'RESORT_MANAGER'])(
    '%s (stock:read only) sees the catalog and movement data but no add-item form, log-movement button, or deactivate control',
    async (roleKey) => {
      const viewOnlyUser = { ...stockManagerUser, roles: [roleKey], permissions: { 'stock:read': 'ALL' } };
      const lowItem = { id: 'stock_2', name: 'Dish Soap', category: 'KITCHEN', unitOfMeasure: 'bottle', currentQty: 2, reorderLevel: 5, isActive: true };

      const fetchMock = vi.fn((input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/auth/me')) return jsonResponse(200, { user: viewOnlyUser });
        if (url.endsWith('/stock-items')) return jsonResponse(200, { stockItems: [stockItem, lowItem] });
        return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
      });
      vi.stubGlobal('fetch', fetchMock);
      window.history.pushState({}, '', '/stock');

      render(<App />);

      await waitFor(() => expect(screen.getByRole('heading', { name: 'Stock' })).toBeInTheDocument());

      // Read-only content renders: both real items, including the
      // below-threshold one — not an empty or broken page. The loading
      // skeleton is also a <table>, a different element than the one
      // that replaces it once data arrives — re-querying inside
      // waitFor (rather than capturing a `table` reference beforehand)
      // is what makes this wait for the real, post-load table.
      await waitFor(() => expect(within(screen.getByRole('table')).getByText('Toilet Paper (12-roll pack)')).toBeInTheDocument());
      const table = screen.getByRole('table');
      expect(within(table).getByText('Dish Soap')).toBeInTheDocument();
      expect(within(table).getByText('2')).toBeInTheDocument();

      // No Actions column at all — canLogMovement and canManage are both
      // false, so the column header and every cell in it are absent.
      expect(screen.queryByRole('columnheader', { name: 'Actions' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Log movement' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Deactivate' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Reactivate' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();

      // No catalog form anywhere on the page.
      expect(screen.queryByRole('form', { name: 'Add an item' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Add item' })).not.toBeInTheDocument();
    },
  );

  it('a viewer with no stock:* access at all does not see the Stock nav item or page', async () => {
    const noStockUser = { ...stockManagerUser, roles: ['RESORT_STAFF'], permissions: { 'unit:read': 'ALL' } };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: noStockUser });
      if (url.includes('/units/dashboard')) return jsonResponse(200, dashboardPayload);
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
