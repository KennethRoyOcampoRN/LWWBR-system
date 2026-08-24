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
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => expect(screen.getByText('Sisig')).toBeInTheDocument());
    expect(screen.queryByText('Add a menu item')).not.toBeInTheDocument();
    expect(screen.queryByText('Mark unavailable')).not.toBeInTheDocument();
  });
});
