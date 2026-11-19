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
      if (url.endsWith('/unit-types')) return jsonResponse(200, { unitTypes: [{ id: 't1', name: 'Standard Room', defaultCapacity: 2, baseRate: 1500 }] });
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
      if (url.endsWith('/unit-types')) return jsonResponse(200, { unitTypes: [{ id: 't1', name: 'Standard Room', defaultCapacity: 2, baseRate: 1500 }] });
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
      if (url.endsWith('/unit-types')) return jsonResponse(200, { unitTypes: [{ id: 't1', name: 'Standard Room', defaultCapacity: 2, baseRate: 1500 }] });
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

  // Spec.md §13 decision 36 (2026-11-19): UNIT_HAS_HISTORY can no longer
  // happen — delete is a soft delete now, so a unit with real history
  // (bookings, work orders, status events) deletes successfully, same
  // as one with none. This is the client's own fix verified: "i cannot
  // delete rooms with history... it should be able to delete."
  it('deletes an inactive unit that has real history, same as one with none', async () => {
    window.history.pushState({}, '', '/units');
    const user = userEvent.setup();
    const inactiveRoom = { ...room, isActive: false };
    let deleteCalled = false;
    let units = [inactiveRoom];

    vi.spyOn(window, 'confirm').mockReturnValue(true);

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: managerUser });
      if (url.endsWith('/units') && (!init || init.method === undefined)) return jsonResponse(200, { units });
      if (url.endsWith('/unit-types')) return jsonResponse(200, { unitTypes: [{ id: 't1', name: 'Standard Room', defaultCapacity: 2, baseRate: 1500 }] });
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

  function stubFetch(
    userFixture: typeof managerUser,
    opts: { onCreate?: (body: Record<string, unknown>) => void; deleteError?: { code: string; message: string } } = {},
  ) {
    let deleted = false;
    return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: userFixture });
      if (url.endsWith('/units')) return jsonResponse(200, { units: [] });
      if (url.endsWith('/unit-types') && (!init || init.method === undefined)) {
        return jsonResponse(200, { unitTypes: deleted ? [] : [standardRoom] });
      }
      if (url.endsWith('/unit-types') && init?.method === 'POST') {
        const body = JSON.parse(init.body as string);
        opts.onCreate?.(body);
        return jsonResponse(201, { unitType: { ...standardRoom, id: 'type_2', ...body } });
      }
      if (url.endsWith('/unit-types/type_1') && init?.method === 'DELETE') {
        if (opts.deleteError) return jsonResponse(409, { error: opts.deleteError });
        deleted = true;
        return jsonResponse(204, {});
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

  // Spec.md §13 decision 37 (2026-11-19): base rate/day tour rate/extra
  // person rate removed from this form entirely — a room type is
  // identity and capacity now, never a price (pricing moved onto
  // RatePlanRate). Confirms both that the fields are gone from the form
  // and that create submits no price field at all.
  it('adds a room type with no price fields — identity and capacity only', async () => {
    const user = userEvent.setup();
    let createdBody: Record<string, unknown> | null = null;
    const managerWithUnitType = { ...managerUser, permissions: { ...managerUser.permissions, 'unittype:manage': 'ALL' } };
    vi.stubGlobal('fetch', stubFetch(managerWithUnitType, { onCreate: (body) => (createdBody = body) }));
    window.history.pushState({}, '', '/units');
    render(<App />);

    await waitFor(() => expect(screen.getByText('Add a room type')).toBeInTheDocument());
    expect(screen.queryByLabelText('Base rate (₱)')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Day tour rate/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Extra person rate/)).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Name'), 'Deluxe Room');
    await user.click(screen.getByRole('button', { name: 'Add room type' }));

    await waitFor(() => expect(createdBody).not.toBeNull());
    expect(createdBody).toEqual({ name: 'Deluxe Room', defaultCapacity: 2 });
  });

  // Caught live, 2026-11-18: the client created a duplicate "Family
  // Room" by accident with no way to remove it — only Deactivate
  // existed. Same no-reason-required rule as deleting a never-
  // receipted folio charge.
  it('deletes a room type with a plain confirm, no reason required', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const managerWithUnitType = { ...managerUser, permissions: { ...managerUser.permissions, 'unittype:manage': 'ALL' } };
    vi.stubGlobal('fetch', stubFetch(managerWithUnitType));
    window.history.pushState({}, '', '/units');
    render(<App />);

    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Delete' }).length).toBeGreaterThan(0));
    await user.click(screen.getAllByRole('button', { name: 'Delete' })[0]!);

    expect(window.confirm).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryAllByText('Standard Room').length).toBe(0));
  });

  it('shows the server-named room count when a room type is still in use', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const managerWithUnitType = { ...managerUser, permissions: { ...managerUser.permissions, 'unittype:manage': 'ALL' } };
    vi.stubGlobal(
      'fetch',
      stubFetch(managerWithUnitType, {
        deleteError: { code: 'UNIT_TYPE_IN_USE', message: '3 rooms still use this room type — reassign them before deleting it.' },
      }),
    );
    window.history.pushState({}, '', '/units');
    render(<App />);

    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Delete' }).length).toBeGreaterThan(0));
    await user.click(screen.getAllByRole('button', { name: 'Delete' })[0]!);

    await screen.findByText('3 rooms still use this room type — reassign them before deleting it.');
  });
});

// Spec.md §13 decision 29/30 (2026-11-15): the admin CRUD surface for
// named rate plans, alongside Setup: Rooms since that's where room
// pricing already lives. rateplan:manage, not unittype:manage — a
// deliberately separate permission.
describe('UnitsPage — Rate Plans', () => {
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
  const standardPlan = {
    id: 'plan_1',
    name: 'Standard',
    startDate: null,
    endDate: null,
    weekdayMask: null,
    isActive: true,
    rates: [
      {
        id: 'rate_1',
        unitTypeId: 'type_1',
        rate: 1500,
        dayTourRate: null,
        extraPersonRate: null,
        unitType: { id: 'type_1', name: 'Standard Room' },
      },
    ],
  };

  const familyRoom = {
    id: 'type_2',
    name: 'Family Room',
    description: null,
    defaultCapacity: 4,
    baseRate: 2500,
    dayTourRate: null,
    extraPersonRate: null,
    colorHex: null,
    isActive: true,
    sortOrder: 1,
  };

  function stubFetch(
    userFixture: typeof managerUser,
    opts: {
      onCreatePlan?: (body: Record<string, unknown>) => void;
      onSetRate?: (body: Record<string, unknown>) => void;
      onToggleActive?: (body: Record<string, unknown>) => void;
      unitTypes?: Record<string, unknown>[];
      units?: Record<string, unknown>[];
      ratePlans?: Record<string, unknown>[];
    } = {},
  ) {
    return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: userFixture });
      if (url.endsWith('/units')) return jsonResponse(200, { units: opts.units ?? [] });
      if (url.endsWith('/unit-types')) return jsonResponse(200, { unitTypes: opts.unitTypes ?? [standardRoom] });
      if (url.endsWith('/rate-plans') && (!init || init.method === undefined)) {
        return jsonResponse(200, { ratePlans: opts.ratePlans ?? [standardPlan] });
      }
      if (url.endsWith('/rate-plans') && init?.method === 'POST') {
        const body = JSON.parse(init.body as string);
        opts.onCreatePlan?.(body);
        return jsonResponse(201, { ratePlan: { ...standardPlan, id: 'plan_2', ...body, rates: [] } });
      }
      if (url.endsWith('/rate-plans/plan_1') && init?.method === 'PATCH') {
        const body = JSON.parse(init.body as string);
        opts.onToggleActive?.(body);
        return jsonResponse(200, { ratePlan: { ...standardPlan, ...body } });
      }
      if (url.includes('/rate-plans/plan_1/rates/') && init?.method === 'PUT') {
        const body = JSON.parse(init.body as string);
        opts.onSetRate?.(body);
        return jsonResponse(200, {
          rate: {
            id: 'rate_1',
            ratePlanId: 'plan_1',
            unitTypeId: 'type_1',
            rate: body.rate,
            dayTourRate: body.dayTourRate ?? null,
            extraPersonRate: body.extraPersonRate ?? null,
          },
        });
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
  }

  it('shows the Rate Plans section for a rateplan:manage holder', async () => {
    const managerWithRatePlan = { ...managerUser, permissions: { ...managerUser.permissions, 'rateplan:manage': 'ALL' } };
    vi.stubGlobal('fetch', stubFetch(managerWithRatePlan));
    window.history.pushState({}, '', '/units');
    render(<App />);

    await waitFor(() => expect(screen.getByText('Rate Plans')).toBeInTheDocument());
    await waitFor(() => expect(screen.getAllByText('Standard').length).toBeGreaterThan(0));
  });

  it('hides the Rate Plans section from a holder without rateplan:manage', async () => {
    vi.stubGlobal('fetch', stubFetch(managerUser));
    window.history.pushState({}, '', '/units');
    render(<App />);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Units' })).toBeInTheDocument());
    expect(screen.queryByText('Rate Plans')).not.toBeInTheDocument();
  });

  it('creates a rate plan with suggestion dates', async () => {
    const user = userEvent.setup();
    let createdBody: Record<string, unknown> | null = null;
    const managerWithRatePlan = { ...managerUser, permissions: { ...managerUser.permissions, 'rateplan:manage': 'ALL' } };
    vi.stubGlobal('fetch', stubFetch(managerWithRatePlan, { onCreatePlan: (body) => (createdBody = body) }));
    window.history.pushState({}, '', '/units');
    render(<App />);

    await waitFor(() => expect(screen.getByText('Add a rate plan')).toBeInTheDocument());
    await user.type(screen.getByLabelText('Name'), 'December Xmas');
    await user.type(screen.getByLabelText('Suggest from (optional)'), '2026-12-01');
    await user.type(screen.getByLabelText('Suggest to (optional)'), '2026-12-31');
    await user.click(screen.getByRole('button', { name: 'Add rate plan' }));

    await waitFor(() => expect(createdBody).not.toBeNull());
    expect(createdBody).toMatchObject({ name: 'December Xmas', startDate: '2026-12-01', endDate: '2026-12-31' });
  });

  it('edits a rate for a room type under a plan', async () => {
    const user = userEvent.setup();
    let setRateBody: Record<string, unknown> | null = null;
    const managerWithRatePlan = { ...managerUser, permissions: { ...managerUser.permissions, 'rateplan:manage': 'ALL' } };
    vi.stubGlobal('fetch', stubFetch(managerWithRatePlan, { onSetRate: (body) => (setRateBody = body) }));
    window.history.pushState({}, '', '/units');
    render(<App />);

    await waitFor(() => expect(screen.getAllByText('Standard').length).toBeGreaterThan(0));
    // DataTable's own responsive split renders both a desktop table row and
    // a mobile card for the same data — same reason decision 22/23's own
    // tests click the first match rather than assuming exactly one exists.
    await user.click(screen.getAllByRole('button', { name: 'Edit rates' })[0]!);
    await waitFor(() => expect(screen.getByText('Rates for "Standard"')).toBeInTheDocument());

    // Disambiguation label (capacity) — see unitTypeOptionLabel's own
    // comment for why a bare name isn't used.
    const input = screen.getByLabelText('Standard Room — 2 pax');
    await user.clear(input);
    await user.type(input, '1800');
    await user.click(screen.getAllByRole('button', { name: 'Save' })[0]!);

    // Full replace, per decision 37 — day tour/extra person are sent
    // as null (left blank in this row's draft), not omitted.
    await waitFor(() => expect(setRateBody).toEqual({ rate: 1800, dayTourRate: null, extraPersonRate: null }));
  });

  // Spec.md §13 decision 37 (2026-11-19): the client's own two live
  // examples — Day Tour Cottage's ₱1,200 day-tour rate against an
  // ₱1,800 overnight rate, and Family Room's ₱299.99 extra-person
  // rate — both now settable on the same RatePlanRate row, since a
  // plan is a complete price list.
  it('edits the day tour and extra person rates alongside the nightly rate', async () => {
    const user = userEvent.setup();
    let setRateBody: Record<string, unknown> | null = null;
    const managerWithRatePlan = { ...managerUser, permissions: { ...managerUser.permissions, 'rateplan:manage': 'ALL' } };
    vi.stubGlobal('fetch', stubFetch(managerWithRatePlan, { onSetRate: (body) => (setRateBody = body) }));
    window.history.pushState({}, '', '/units');
    render(<App />);

    await waitFor(() => expect(screen.getAllByText('Standard').length).toBeGreaterThan(0));
    await user.click(screen.getAllByRole('button', { name: 'Edit rates' })[0]!);
    await waitFor(() => expect(screen.getByText('Rates for "Standard"')).toBeInTheDocument());

    const row = screen.getByLabelText('Standard Room — 2 pax').closest('div')!.parentElement!;
    await user.type(within(row).getByLabelText('Day tour (₱, optional)'), '1200');
    await user.type(within(row).getByLabelText('Extra person (₱, optional)'), '299.99');
    await user.click(within(row).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(setRateBody).toEqual({ rate: 1500, dayTourRate: 1200, extraPersonRate: 299.99 }));
  });

  // Caught live, 2026-11-18: the client's own "WEEKDAYS" plan read
  // "0 / 6 room types" set, but the editor itself gave no indication
  // of which types those were until charging one actually failed.
  it('flags a room type with no rate set in the rate editor', async () => {
    const user = userEvent.setup();
    const managerWithRatePlan = { ...managerUser, permissions: { ...managerUser.permissions, 'rateplan:manage': 'ALL' } };
    vi.stubGlobal('fetch', stubFetch(managerWithRatePlan, { unitTypes: [standardRoom, familyRoom] }));
    window.history.pushState({}, '', '/units');
    render(<App />);

    await waitFor(() => expect(screen.getAllByText('Standard').length).toBeGreaterThan(0));
    await user.click(screen.getAllByRole('button', { name: 'Edit rates' })[0]!);
    await waitFor(() => expect(screen.getByText('Rates for "Standard"')).toBeInTheDocument());

    // Family Room has no rate under this plan (standardPlan.rates only
    // covers type_1) — Standard Room does, and isn't flagged. Two
    // levels up from the input: Field's own wrapper, then the row.
    const familyRow = screen.getByLabelText('Family Room — 4 pax').closest('div')!.parentElement!;
    expect(within(familyRow).getByText('No rate set')).toBeInTheDocument();
    const standardRow = screen.getByLabelText('Standard Room — 2 pax').closest('div')!.parentElement!;
    expect(within(standardRow).queryByText('No rate set')).not.toBeInTheDocument();
  });

  // Caught live, 2026-11-18: the client's own concern — a cashier
  // hitting RATE_PLAN_RATE_MISSING at charge time because a room type
  // with rooms actually assigned was never priced under the activated
  // plan. Warn before activating, not after a failed charge.
  it('warns before activating a plan that leaves an in-use room type unpriced, and can be cancelled', async () => {
    const user = userEvent.setup();
    let toggleBody: Record<string, unknown> | null = null;
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const managerWithRatePlan = { ...managerUser, permissions: { ...managerUser.permissions, 'rateplan:manage': 'ALL' } };
    vi.stubGlobal(
      'fetch',
      stubFetch(managerWithRatePlan, {
        unitTypes: [standardRoom, familyRoom],
        units: [{ id: 'bu_1', code: 'F01', name: 'Family 1', unitTypeId: 'type_2', type: 'ROOM', capacity: 4, floor: null, status: 'READY', version: 0, notes: null, isActive: true, sortOrder: 0, latestNote: null, currentBooking: null }],
        ratePlans: [{ ...standardPlan, isActive: false }],
        onToggleActive: (body) => (toggleBody = body),
      }),
    );
    window.history.pushState({}, '', '/units');
    render(<App />);

    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Activate' }).length).toBeGreaterThan(0));
    await user.click(screen.getAllByRole('button', { name: 'Activate' })[0]!);

    expect(confirmSpy).toHaveBeenCalled();
    expect(confirmSpy.mock.calls[0]![0]).toContain('Family Room');
    expect(toggleBody).toBeNull();

    confirmSpy.mockReturnValue(true);
    await user.click(screen.getAllByRole('button', { name: 'Activate' })[0]!);
    await waitFor(() => expect(toggleBody).toEqual({ isActive: true }));
  });

  it('does not warn when every in-use room type already has a rate', async () => {
    const user = userEvent.setup();
    let toggleBody: Record<string, unknown> | null = null;
    const confirmSpy = vi.spyOn(window, 'confirm');
    const managerWithRatePlan = { ...managerUser, permissions: { ...managerUser.permissions, 'rateplan:manage': 'ALL' } };
    vi.stubGlobal(
      'fetch',
      stubFetch(managerWithRatePlan, {
        units: [{ id: 'bu_1', code: 'R01', name: 'Room 1', unitTypeId: 'type_1', type: 'ROOM', capacity: 2, floor: null, status: 'READY', version: 0, notes: null, isActive: true, sortOrder: 0, latestNote: null, currentBooking: null }],
        ratePlans: [{ ...standardPlan, isActive: false }],
        onToggleActive: (body) => (toggleBody = body),
      }),
    );
    window.history.pushState({}, '', '/units');
    render(<App />);

    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Activate' }).length).toBeGreaterThan(0));
    await user.click(screen.getAllByRole('button', { name: 'Activate' })[0]!);

    expect(confirmSpy).not.toHaveBeenCalled();
    await waitFor(() => expect(toggleBody).toEqual({ isActive: true }));
  });
});

// Spec.md §13 decision 34 (2026-11-18): bulk unit status change. Client's
// real case — morning housekeeping, thirteen rooms Dirty, one person
// clicking through drawers one at a time instead of in bulk.
describe('UnitsPage — bulk status change', () => {
  function dirtyRoom(id: string, code: string) {
    return {
      id, code, name: `Room ${code}`, unitTypeId: 't1', type: 'ROOM', capacity: 2, floor: null,
      status: 'VACANT_DIRTY', version: 3, notes: null, isActive: true, sortOrder: 0, latestNote: null, currentBooking: null,
    };
  }
  function cleanedRoom(id: string, code: string) {
    return {
      id, code, name: `Room ${code}`, unitTypeId: 't1', type: 'ROOM', capacity: 2, floor: null,
      status: 'CLEANED', version: 1, notes: null, isActive: true, sortOrder: 0, latestNote: null, currentBooking: null,
    };
  }
  function stubFetch(units: unknown[], onBulk?: (body: unknown) => void, bulkResponse?: unknown) {
    return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: managerUser });
      if (url.endsWith('/units/bulk-status')) {
        onBulk?.(init?.body ? JSON.parse(init.body as string) : null);
        return jsonResponse(200, bulkResponse ?? { results: [], succeededCount: 0, failedCount: 0 });
      }
      if (url.endsWith('/units')) return jsonResponse(200, { units });
      if (url.endsWith('/unit-types')) return jsonResponse(200, { unitTypes: [] });
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
  }

  it('"select all Dirty" shows the count and offers every status, annotated with how many of the selection can take it', async () => {
    const user = userEvent.setup();
    const rooms = [dirtyRoom('u1', 'D01'), dirtyRoom('u2', 'D02'), cleanedRoom('u3', 'C01')];
    vi.stubGlobal('fetch', stubFetch(rooms));
    window.history.pushState({}, '', '/units');
    render(<App />);

    const selectAllDirty = await screen.findByRole('button', { name: 'Select all Dirty (2)' });
    await user.click(selectAllDirty);

    expect(await screen.findByText('2 rooms selected')).toBeInTheDocument();
    const select = screen.getByLabelText('Change selected rooms to');
    // Client's own words: "selecting all rooms and change status must
    // show all options" — every manually-reachable status shows, not
    // only the one both Dirty rooms can actually take.
    expect(within(select).getByRole('option', { name: 'Cleaning (2 of 2)' })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: 'Ready (0 of 2)' })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: 'Cleaned (0 of 2)' })).toBeInTheDocument();
  });

  it('shows every status for a mixed selection too, each with its own count, instead of an empty-intersection message', async () => {
    const user = userEvent.setup();
    const rooms = [dirtyRoom('u1', 'D01'), cleanedRoom('u2', 'C01')];
    vi.stubGlobal('fetch', stubFetch(rooms));
    window.history.pushState({}, '', '/units');
    render(<App />);

    await waitFor(() => expect(screen.getByText('D01')).toBeInTheDocument());
    await user.click(screen.getByLabelText('Select room D01'));
    await user.click(screen.getByLabelText('Select room C01'));

    const select = await screen.findByLabelText('Change selected rooms to');
    // D01 (Dirty) can go to Cleaning; C01 (Cleaned) can go to Ready —
    // the old intersection would have offered neither.
    expect(within(select).getByRole('option', { name: 'Cleaning (1 of 2)' })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: 'Ready (1 of 2)' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('reports a partial apply on the grid itself — summary line plus a per-card marker on the room that failed', async () => {
    const user = userEvent.setup();
    const rooms = [dirtyRoom('u1', 'D01'), dirtyRoom('u2', 'D02')];
    let bulkBody: unknown = null;
    vi.stubGlobal(
      'fetch',
      stubFetch(
        rooms,
        (body) => (bulkBody = body),
        {
          results: [
            { unitId: 'u1', code: 'D01', status: 'OK' },
            { unitId: 'u2', code: 'D02', status: 'FAILED', message: 'Version conflict — refresh and try again.' },
          ],
          succeededCount: 1,
          failedCount: 1,
        },
      ),
    );
    window.history.pushState({}, '', '/units');
    render(<App />);

    const selectAllDirty = await screen.findByRole('button', { name: 'Select all Dirty (2)' });
    await user.click(selectAllDirty);
    await user.selectOptions(screen.getByLabelText('Change selected rooms to'), 'CLEANING');
    await user.click(screen.getByRole('button', { name: 'Apply' }));

    expect(bulkBody).toEqual({ unitIds: ['u1', 'u2'], toStatus: 'CLEANING' });
    await waitFor(() =>
      expect(screen.getByText("1 of 2 rooms changed to Cleaning. 1 didn't — see below.")).toBeInTheDocument(),
    );
    // Visible right in the action bar's own result list, not a separate panel.
    expect(screen.getByText(/D02: Version conflict/)).toBeInTheDocument();
    // And on the specific card itself.
    expect(screen.getByLabelText(/Could not change: Version conflict/)).toBeInTheDocument();
  });

  it('never offers Occupied as a bulk target, even though every other status is shown', async () => {
    const user = userEvent.setup();
    const readyRoom = {
      id: 'u1', code: 'R01', name: 'Room R01', unitTypeId: 't1', type: 'ROOM', capacity: 2, floor: null,
      status: 'READY', version: 0, notes: null, isActive: true, sortOrder: 0, latestNote: null, currentBooking: null,
    };
    vi.stubGlobal('fetch', stubFetch([readyRoom]));
    window.history.pushState({}, '', '/units');
    render(<App />);

    await waitFor(() => expect(screen.getByLabelText('Select room R01')).toBeInTheDocument());
    await user.click(screen.getByLabelText('Select room R01'));

    const select = await screen.findByLabelText('Change selected rooms to');
    // Every manually-reachable status still shows (0 of 1 for all of
    // them here, since this actor holds no unit:block) — Occupied is
    // the one status that never appears, at any count, for anyone.
    expect(within(select).getByRole('option', { name: 'Cleaning (0 of 1)' })).toBeInTheDocument();
    expect(within(select).queryByText(/Occupied/i, { selector: 'option' })).not.toBeInTheDocument();
  });

  it('hides the selection checkboxes entirely for a user without any status-change permission', async () => {
    const readOnlyUser = { ...managerUser, permissions: { 'unit:read': 'ALL' } };
    vi.stubGlobal('fetch', stubFetch([dirtyRoom('u1', 'D01')]));
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: readOnlyUser });
      if (url.endsWith('/units')) return jsonResponse(200, { units: [dirtyRoom('u1', 'D01')] });
      if (url.endsWith('/unit-types')) return jsonResponse(200, { unitTypes: [] });
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState({}, '', '/units');
    render(<App />);

    await waitFor(() => expect(screen.getByText('D01')).toBeInTheDocument());
    expect(screen.queryByLabelText('Select room D01')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Select all Dirty/ })).not.toBeInTheDocument();
  });
});
