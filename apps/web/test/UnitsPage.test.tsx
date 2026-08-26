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
  permissions: {
    'unit:read': 'ALL',
    'unit:update_status': 'ALL',
    'unit:manage': 'ALL',
    'booking:checkin': 'ALL',
    'booking:checkout': 'ALL',
  },
};

const room = { id: 'unit_1', code: 'R01', name: 'Room 1', unitTypeId: 't1', type: 'ROOM', capacity: 4, floor: null, status: 'READY', version: 0, notes: null, isActive: true, sortOrder: 0, latestNote: null };
const cottage = { id: 'unit_2', code: 'C01', name: 'Cottage 1', unitTypeId: 't2', type: 'COTTAGE', capacity: 6, floor: null, status: 'READY', version: 0, notes: null, isActive: true, sortOrder: 1, latestNote: null };
const pool = { id: 'unit_3', code: 'POOL', name: 'Pool', unitTypeId: 't3', type: 'FACILITY', capacity: 0, floor: null, status: 'READY', version: 0, notes: null, isActive: true, sortOrder: 2, latestNote: null };
const restroom = { id: 'unit_4', code: 'CR-F', name: 'CR-Female', unitTypeId: 't4', type: 'COMMON_AREA', capacity: 0, floor: null, status: 'READY', version: 0, notes: null, isActive: true, sortOrder: 3, latestNote: null };

describe('UnitsPage — Check-in room picker', () => {
  // Real bug found live-testing, 2026-08-25: common areas (Beach Front,
  // CR-Female/Male, Function Hall, Pool, Restaurant) were listed as
  // selectable check-in destinations alongside real accommodations.
  it('lists only ROOM/COTTAGE units, never COMMON_AREA/FACILITY ones', async () => {
    window.history.pushState({}, '', '/units');
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: managerUser });
      if (url.endsWith('/units')) return jsonResponse(200, { units: [room, cottage, pool, restroom] });
      if (url.endsWith('/unit-types')) return jsonResponse(200, { unitTypes: [] });
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => expect(screen.getByText('Rooms')).toBeInTheDocument());

    // The picker list is inside the "Rooms" <details> — scope the query
    // there so the main unit grid's own tiles (which do show POOL/CR-F)
    // aren't mistaken for picker entries.
    const picker = await waitFor(() => screen.getByText('Rooms').closest('details')!);
    await waitFor(() => expect(picker.textContent).toContain('R01'));
    expect(picker.textContent).toContain('R01');
    expect(picker.textContent).toContain('C01');
    expect(picker.textContent).not.toContain('POOL');
    expect(picker.textContent).not.toContain('CR-F');
    // 2 checkboxes: one per bookable unit, none for the two common areas.
    expect(picker.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
  });
});

describe('UnitsPage — unit management (real gap found live-testing, 2026-08-25: no UI existed to add/edit/deactivate a unit at all)', () => {
  it('groups the grid into Rooms & Cottages / Common areas / Facilities, Facilities shown even while empty', async () => {
    window.history.pushState({}, '', '/units');
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: managerUser });
      if (url.endsWith('/units')) return jsonResponse(200, { units: [room, cottage, restroom] });
      if (url.endsWith('/unit-types')) return jsonResponse(200, { unitTypes: [] });
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => expect(screen.getByText('Rooms & Cottages (2)')).toBeInTheDocument());
    expect(screen.getByText('Common areas (1)')).toBeInTheDocument();
    // Client decision: Facilities stays its own section, never folded
    // into Common areas, even with zero real units today.
    expect(screen.getByText('Facilities (0)')).toBeInTheDocument();
  });

  it('a unit:manage holder can add a unit via the Add unit form', async () => {
    window.history.pushState({}, '', '/units');
    const user = userEvent.setup();
    let units = [room];
    let createdBody: Record<string, unknown> | null = null;

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: managerUser });
      if (url.endsWith('/units') && (!init || init.method === undefined)) return jsonResponse(200, { units });
      if (url.endsWith('/units') && init?.method === 'POST') {
        const body = JSON.parse(init.body as string) as Record<string, unknown>;
        createdBody = body;
        const created = { ...room, id: 'unit_new', code: String(body.code), name: String(body.name), type: String(body.type) };
        units = [...units, created];
        return jsonResponse(201, { unit: created });
      }
      if (url.endsWith('/unit-types')) return jsonResponse(200, { unitTypes: [{ id: 't1', name: 'Standard Room' }] });
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => expect(screen.getByText('+ Add unit')).toBeInTheDocument());
    await user.click(screen.getByText('+ Add unit'));

    await user.selectOptions(screen.getByLabelText('Unit type (rate/capacity template)'), 't1');
    await user.type(screen.getByLabelText('Code'), 'R21');
    await user.type(screen.getByLabelText('Name'), 'Room 21');
    await user.click(screen.getByRole('button', { name: 'Add unit' }));

    await waitFor(() => expect(createdBody).not.toBeNull());
    expect(createdBody).toMatchObject({ code: 'R21', name: 'Room 21', type: 'ROOM', unitTypeId: 't1' });
    await waitFor(() => expect(screen.getByText('Rooms & Cottages (2)')).toBeInTheDocument());
  });

  it('a unit:manage holder can edit a unit\'s details and deactivate it from the drawer', async () => {
    window.history.pushState({}, '', '/units');
    const user = userEvent.setup();
    let currentRoom = { ...room };

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: managerUser });
      if (url.endsWith('/units') && (!init || init.method === undefined)) return jsonResponse(200, { units: [currentRoom] });
      if (url.endsWith('/unit-types')) return jsonResponse(200, { unitTypes: [{ id: 't1', name: 'Standard Room' }] });
      if (url.match(/\/units\/unit_1\/timeline$/)) return jsonResponse(200, { events: [] });
      if (url.match(/\/units\/unit_1\/bookings$/)) return jsonResponse(200, { bookings: [] });
      if (url.match(/\/units\/unit_1$/) && init?.method === 'PATCH') {
        const body = JSON.parse(init.body as string);
        currentRoom = { ...currentRoom, ...body };
        return jsonResponse(200, { unit: currentRoom });
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => expect(screen.getByText('R01')).toBeInTheDocument());
    await user.click(screen.getByText('R01'));

    await waitFor(() => expect(screen.getByText('Unit details')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Edit' }));

    const nameInputs = screen.getAllByDisplayValue('Room 1');
    await user.clear(nameInputs[0]!);
    await user.type(nameInputs[0]!, 'Room 1 Deluxe');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(currentRoom.name).toBe('Room 1 Deluxe'));

    await user.click(screen.getByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(currentRoom.isActive).toBe(false));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reactivate' })).toBeInTheDocument());
  });

  // Client decision, 2026-08-25: a real delete, but only for a unit with
  // zero real history. Delete is only offered once already inactive, and
  // confirms before actually deleting.
  it('deletes an inactive unit with no history after confirmation', async () => {
    window.history.pushState({}, '', '/units');
    const user = userEvent.setup();
    let units = [{ ...room, isActive: false }];
    let deleteCalled = false;

    vi.spyOn(window, 'confirm').mockReturnValue(true);

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: managerUser });
      if (url.endsWith('/units') && (!init || init.method === undefined)) return jsonResponse(200, { units });
      if (url.endsWith('/unit-types')) return jsonResponse(200, { unitTypes: [{ id: 't1', name: 'Standard Room' }] });
      if (url.match(/\/units\/unit_1\/timeline$/)) return jsonResponse(200, { events: [] });
      if (url.match(/\/units\/unit_1\/bookings$/)) return jsonResponse(200, { bookings: [] });
      if (url.match(/\/units\/unit_1$/) && init?.method === 'DELETE') {
        deleteCalled = true;
        units = [];
        return jsonResponse(204, undefined);
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => expect(screen.getByText('R01')).toBeInTheDocument());
    await user.click(screen.getByText('R01'));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(deleteCalled).toBe(true));
    await waitFor(() => expect(screen.queryByText('Unit details')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.queryByText('R01')).not.toBeInTheDocument());
  });

  it('shows the server\'s UNIT_HAS_HISTORY error rather than deleting a unit with real history', async () => {
    window.history.pushState({}, '', '/units');
    const user = userEvent.setup();
    const inactiveRoom = { ...room, isActive: false };

    vi.spyOn(window, 'confirm').mockReturnValue(true);

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: managerUser });
      if (url.endsWith('/units') && (!init || init.method === undefined)) return jsonResponse(200, { units: [inactiveRoom] });
      if (url.endsWith('/unit-types')) return jsonResponse(200, { unitTypes: [{ id: 't1', name: 'Standard Room' }] });
      if (url.match(/\/units\/unit_1\/timeline$/)) return jsonResponse(200, { events: [] });
      if (url.match(/\/units\/unit_1\/bookings$/)) return jsonResponse(200, { bookings: [] });
      if (url.match(/\/units\/unit_1$/) && init?.method === 'DELETE') {
        return jsonResponse(409, {
          error: {
            code: 'UNIT_HAS_HISTORY',
            message: 'This unit has real history (bookings, work orders, or status changes) and cannot be deleted. Deactivate it instead.',
          },
        });
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => expect(screen.getByText('R01')).toBeInTheDocument());
    await user.click(screen.getByText('R01'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('cannot be deleted'));
    // Still shown — the unit was not removed from the grid.
    expect(screen.getByText('Unit details')).toBeInTheDocument();
  });
});
