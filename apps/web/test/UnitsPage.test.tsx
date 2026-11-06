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

// Build plan stage 4 (spec.md §13 decision 13, 2026-11-04): the one
// entry point into billing — there's no standalone "pick a booking"
// screen, so this link on a booking row (next to Check out) is the
// only place a cashier reaches a specific booking's billing page.
describe('UnitsPage — billing entry point', () => {
  const occupiedWithBooking = {
    id: 'unit_1', code: 'R01', name: 'Room 1', unitTypeId: 't1', type: 'ROOM', capacity: 4, floor: null,
    status: 'OCCUPIED', version: 0, notes: null, isActive: true, sortOrder: 0, latestNote: null,
  };
  const upcomingBooking = {
    id: 'booking_1', referenceNo: 'EXT-100', guestName: 'Roel Villagomez', type: 'OVERNIGHT', status: 'CHECKED_IN',
    startAt: '2026-11-04T00:00:00.000Z', endAt: null,
  };

  function stubFetch(userFixture: typeof managerUser) {
    return vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: userFixture });
      if (url.endsWith('/units')) return jsonResponse(200, { units: [occupiedWithBooking] });
      if (url.endsWith('/unit-types')) return jsonResponse(200, { unitTypes: [] });
      if (url.match(/\/units\/unit_1\/timeline$/)) return jsonResponse(200, { events: [] });
      if (url.match(/\/units\/unit_1\/bookings$/)) return jsonResponse(200, { bookings: [upcomingBooking] });
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
  }

  it('shows a "Bill guest" link to /billing/:bookingId for a receipt:issue holder', async () => {
    const user = userEvent.setup();
    const cashierLikeUser = { ...managerUser, permissions: { ...managerUser.permissions, 'receipt:issue': 'ALL' } };
    vi.stubGlobal('fetch', stubFetch(cashierLikeUser));
    render(<App />);

    await waitFor(() => expect(screen.getByText('R01')).toBeInTheDocument());
    await user.click(screen.getByText('R01'));

    const link = await screen.findByRole('link', { name: 'Bill guest' });
    expect(link).toHaveAttribute('href', '/billing/booking_1');
  });

  it('hides "Bill guest" from a holder without receipt:issue', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', stubFetch(managerUser));
    render(<App />);

    await waitFor(() => expect(screen.getByText('R01')).toBeInTheDocument());
    await user.click(screen.getByText('R01'));

    await waitFor(() => expect(screen.getByText(/Booked: Roel Villagomez/)).toBeInTheDocument());
    expect(screen.queryByRole('link', { name: 'Bill guest' })).not.toBeInTheDocument();
  });
});

// Spec.md §13 decision 18 (2026-11-06): warn but allow, not an
// unconditional status flip — same confirm-and-proceed shape
// BillingPage.tsx already uses for DUPLICATE_BILLING_NUMBER.
describe('UnitsPage — checkout outstanding-balance warning', () => {
  const occupiedWithBooking = {
    id: 'unit_1', code: 'R01', name: 'Room 1', unitTypeId: 't1', type: 'ROOM', capacity: 4, floor: null,
    status: 'OCCUPIED', version: 0, notes: null, isActive: true, sortOrder: 0, latestNote: null,
  };
  const upcomingBooking = {
    id: 'booking_1', referenceNo: 'EXT-100', guestName: 'Roel Villagomez', type: 'OVERNIGHT', status: 'CHECKED_IN',
    startAt: '2026-11-04T00:00:00.000Z', endAt: null,
  };
  const checklistCandidate = { unitId: 'unit_1', code: 'R01', name: 'Room 1', bookingId: 'booking_1', guestName: 'Roel Villagomez' };

  const checkoutUser = { ...managerUser, permissions: { ...managerUser.permissions, 'booking:checkout': 'ALL' } };

  it('409s with the balance, then checks out anyway once the cashier confirms the warning', async () => {
    const user = userEvent.setup();
    let checkoutCallCount = 0;
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: checkoutUser });
      if (url.endsWith('/units')) return jsonResponse(200, { units: [occupiedWithBooking] });
      if (url.endsWith('/unit-types')) return jsonResponse(200, { unitTypes: [] });
      if (url.match(/\/units\/unit_1\/timeline$/)) return jsonResponse(200, { events: [] });
      if (url.match(/\/units\/unit_1\/bookings$/)) return jsonResponse(200, { bookings: [upcomingBooking] });
      if (url.includes('/bookings/group')) return jsonResponse(200, { units: [checklistCandidate] });
      if (url.endsWith('/bookings/checkout') && init?.method === 'POST') {
        checkoutCallCount += 1;
        const body = JSON.parse(init.body as string);
        if (!body.confirmOutstandingBalance) {
          return jsonResponse(409, {
            error: { code: 'OUTSTANDING_BALANCE', message: 'This booking still has an outstanding balance of ₱1,500.00. Confirm to check out anyway.' },
          });
        }
        return jsonResponse(200, { checkedOutUnitIds: ['unit_1'], finalizedBookingIds: ['booking_1'] });
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => expect(screen.getByText('R01')).toBeInTheDocument());
    await user.click(screen.getByText('R01'));
    await user.click(await screen.findByRole('button', { name: 'Check out' }));

    const confirmButton = await screen.findByRole('button', { name: /Check out 1 room/ });
    await user.click(confirmButton);

    await waitFor(() => expect(checkoutCallCount).toBe(2));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('₱1,500.00'));
  });

  it('does not warn when the balance is already zero', async () => {
    const user = userEvent.setup();
    let checkoutCallCount = 0;

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: checkoutUser });
      if (url.endsWith('/units')) return jsonResponse(200, { units: [occupiedWithBooking] });
      if (url.endsWith('/unit-types')) return jsonResponse(200, { unitTypes: [] });
      if (url.match(/\/units\/unit_1\/timeline$/)) return jsonResponse(200, { events: [] });
      if (url.match(/\/units\/unit_1\/bookings$/)) return jsonResponse(200, { bookings: [upcomingBooking] });
      if (url.includes('/bookings/group')) return jsonResponse(200, { units: [checklistCandidate] });
      if (url.endsWith('/bookings/checkout') && init?.method === 'POST') {
        checkoutCallCount += 1;
        return jsonResponse(200, { checkedOutUnitIds: ['unit_1'], finalizedBookingIds: ['booking_1'] });
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => expect(screen.getByText('R01')).toBeInTheDocument());
    await user.click(screen.getByText('R01'));
    await user.click(await screen.findByRole('button', { name: 'Check out' }));
    await user.click(await screen.findByRole('button', { name: /Check out 1 room/ }));

    await waitFor(() => expect(checkoutCallCount).toBe(1));
  });
});

// Cashier-tab plan, Stage C (2026-11-05): "the unit cards must show
// booking ID and guest name" (client's own words), distinguishing a
// CONFIRMED (pre-arrival, room OCCUPIED but nobody there yet) booking
// from a CHECKED_IN one — decision 16's own stated mitigation for the
// OCCUPIED-at-booking-time design, now actually wired up.
describe('UnitsPage — unit card booking summary', () => {
  function stubFetch(currentBooking: { bookingId: string; referenceNo: string; guestName: string; status: string } | null) {
    const unit = {
      id: 'unit_1', code: 'R01', name: 'Room 1', unitTypeId: 't1', type: 'ROOM', capacity: 4, floor: null,
      status: 'OCCUPIED', version: 0, notes: null, isActive: true, sortOrder: 0, latestNote: null, currentBooking,
    };
    return vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: managerUser });
      if (url.endsWith('/units')) return jsonResponse(200, { units: [unit] });
      if (url.endsWith('/unit-types')) return jsonResponse(200, { unitTypes: [] });
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
  }

  it('shows the guest name and booking ID on an OCCUPIED unit\'s card, with a distinct label for a CONFIRMED (pre-arrival) booking', async () => {
    window.history.pushState({}, '', '/units');
    vi.stubGlobal(
      'fetch',
      stubFetch({ bookingId: 'booking_1', referenceNo: 'EXT-200', guestName: 'Jane Dela Cruz', status: 'CONFIRMED' }),
    );
    render(<App />);

    await waitFor(() => expect(screen.getByText('Jane Dela Cruz')).toBeInTheDocument());
    expect(screen.getByText('Booking ID EXT-200')).toBeInTheDocument();
    expect(screen.getByText('Booked (not arrived)')).toBeInTheDocument();
  });

  it('labels a CHECKED_IN booking distinctly from a CONFIRMED one', async () => {
    window.history.pushState({}, '', '/units');
    vi.stubGlobal(
      'fetch',
      stubFetch({ bookingId: 'booking_1', referenceNo: 'EXT-100', guestName: 'Roel Villagomez', status: 'CHECKED_IN' }),
    );
    render(<App />);

    await waitFor(() => expect(screen.getByText('Roel Villagomez')).toBeInTheDocument());
    expect(screen.getByText('Checked in')).toBeInTheDocument();
    expect(screen.queryByText('Booked (not arrived)')).not.toBeInTheDocument();
  });

  it('shows nothing extra when the unit has no currentBooking', async () => {
    window.history.pushState({}, '', '/units');
    vi.stubGlobal('fetch', stubFetch(null));
    render(<App />);

    await waitFor(() => expect(screen.getByText('R01')).toBeInTheDocument());
    expect(screen.queryByText('Booked (not arrived)')).not.toBeInTheDocument();
    expect(screen.queryByText('Checked in')).not.toBeInTheDocument();
  });
});

// Setup Rooms (client-directed feature, 2026-11-04): POST/PATCH
// /unit-types already existed server-side but nothing in the web app
// ever called them until this section.
describe('UnitsPage — Setup Rooms', () => {
  const standardRoom = {
    id: 'type_1',
    name: 'Standard Room',
    description: null,
    defaultCapacity: 2,
    baseRate: 1500,
    dayTourRate: null,
    extraPersonRate: 300,
    colorHex: null,
    isActive: true,
    sortOrder: 0,
  };

  function stubFetch(userFixture: typeof managerUser, opts: { onCreate?: (body: Record<string, unknown>) => void } = {}) {
    return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: userFixture });
      if (url.endsWith('/units')) return jsonResponse(200, { units: [] });
      if (url.endsWith('/unit-types') && (!init || init.method === undefined)) {
        return jsonResponse(200, { unitTypes: [standardRoom] });
      }
      if (url.endsWith('/unit-types') && init?.method === 'POST') {
        const body = JSON.parse(init.body as string);
        opts.onCreate?.(body);
        return jsonResponse(201, { unitType: { ...standardRoom, id: 'type_2', ...body } });
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
  }

  it('shows the Setup: Rooms section for an unittype:manage holder', async () => {
    const managerWithUnitType = { ...managerUser, permissions: { ...managerUser.permissions, 'unittype:manage': 'ALL' } };
    vi.stubGlobal('fetch', stubFetch(managerWithUnitType));
    window.history.pushState({}, '', '/units');
    render(<App />);

    await waitFor(() => expect(screen.getByText('Setup: Rooms')).toBeInTheDocument());
    await waitFor(() => expect(screen.getAllByText('Standard Room').length).toBeGreaterThan(0));
  });

  it('hides the Setup: Rooms section from a holder without unittype:manage', async () => {
    vi.stubGlobal('fetch', stubFetch(managerUser));
    window.history.pushState({}, '', '/units');
    render(<App />);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Units' })).toBeInTheDocument());
    expect(screen.queryByText('Setup: Rooms')).not.toBeInTheDocument();
  });

  it('adds a room type, submitting the rate fields as numbers', async () => {
    const user = userEvent.setup();
    let createdBody: Record<string, unknown> | null = null;
    const managerWithUnitType = { ...managerUser, permissions: { ...managerUser.permissions, 'unittype:manage': 'ALL' } };
    vi.stubGlobal('fetch', stubFetch(managerWithUnitType, { onCreate: (body) => (createdBody = body) }));
    window.history.pushState({}, '', '/units');
    render(<App />);

    await waitFor(() => expect(screen.getByText('Add a room type')).toBeInTheDocument());
    await user.type(screen.getByLabelText('Name'), 'Deluxe Room');
    await user.clear(screen.getByLabelText('Base rate (₱)'));
    await user.type(screen.getByLabelText('Base rate (₱)'), '2500');
    await user.click(screen.getByRole('button', { name: 'Add room type' }));

    await waitFor(() => expect(createdBody).not.toBeNull());
    expect(createdBody).toMatchObject({ name: 'Deluxe Room', baseRate: 2500 });
  });
});
