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

const cashierUser = {
  id: 'user_1',
  employeeCode: 'LWW-030',
  fullName: 'Cashier One (Demo)',
  email: null,
  department: 'MANAGEMENT',
  mustChangePassword: false,
  roles: ['CASHIER'],
  permissions: {
    'booking:create': 'ALL',
    'booking:read': 'ALL',
    'unit:read': 'ALL',
  },
};

const units = [
  { id: 'unit_1', code: 'R01', name: 'Room 1', unitTypeId: 'ut_1', type: 'ROOM', status: 'READY', isActive: true },
  { id: 'unit_2', code: 'R02', name: 'Room 2', unitTypeId: 'ut_1', type: 'ROOM', status: 'OUT_OF_ORDER', isActive: true },
];

const unitTypes = [{ id: 'ut_1', name: 'Standard Room', baseRate: 2500, dayTourRate: 1200 }];

describe('BookingsPage', () => {
  beforeEach(() => {
    window.history.pushState({}, '', '/');
  });

  it('creates an OVERNIGHT booking and shows the confirmation with the real reference number', async () => {
    const user = userEvent.setup();
    let createBody: unknown = null;

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: cashierUser });
      if (url.endsWith('/units')) return jsonResponse(200, { units });
      if (url.endsWith('/unit-types')) return jsonResponse(200, { unitTypes });
      if (url.endsWith('/bookings') && init?.method === 'POST') {
        createBody = JSON.parse(init.body as string);
        return jsonResponse(201, {
          booking: {
            referenceNo: 'LWW-260825-0001',
            guestName: createBody && (createBody as { guestName: string }).guestName,
            type: 'OVERNIGHT',
            startAt: '2026-08-25T06:00:00.000Z',
            endAt: '2026-08-26T04:00:00.000Z',
            totalAmount: 2500,
            units: [{ unitId: 'unit_1', rate: 2500, unit: { code: 'R01', name: 'Room 1' } }],
          },
        });
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => expect(screen.getByRole('link', { name: 'Bookings' })).toBeInTheDocument());
    await user.click(screen.getByRole('link', { name: 'Bookings' }));
    await waitFor(() => expect(screen.getByText('New booking')).toBeInTheDocument());

    await user.type(screen.getByLabelText('Guest name'), 'Jane Dela Cruz');
    await user.type(screen.getByLabelText('Arrival date'), '2026-08-25');
    await user.type(screen.getByLabelText('Departure date'), '2026-08-26');

    // The OUT_OF_ORDER unit's checkbox must be disabled — availability-
    // aware picker, spec §7.5.
    await waitFor(() => expect(screen.getByText('R02 — Room 2')).toBeInTheDocument());
    const r02Checkbox = screen.getByLabelText('R02 — Room 2') as HTMLInputElement;
    expect(r02Checkbox).toBeDisabled();

    const r01Checkbox = screen.getByLabelText('R01 — Room 1');
    await user.click(r01Checkbox);
    // Rate auto-fills from UnitType.baseRate once the unit is selected.
    await waitFor(() => expect(screen.getByLabelText('Rate')).toHaveValue(2500));

    await user.click(screen.getByRole('button', { name: 'Create booking' }));

    expect(await screen.findByText('Created LWW-260825-0001 for Jane Dela Cruz.')).toBeInTheDocument();
    expect(createBody).toEqual(
      expect.objectContaining({
        guestName: 'Jane Dela Cruz',
        type: 'OVERNIGHT',
        arrivalDate: '2026-08-25',
        departureDate: '2026-08-26',
        units: [{ unitId: 'unit_1', rate: 2500 }],
      }),
    );

    // Form resets after a successful create.
    expect(screen.getByLabelText('Guest name')).toHaveValue('');
  });

  it('shows the real 409 UNIT_UNAVAILABLE error inline with the conflicting reference number', async () => {
    const user = userEvent.setup();

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: cashierUser });
      if (url.endsWith('/units')) return jsonResponse(200, { units });
      if (url.endsWith('/unit-types')) return jsonResponse(200, { unitTypes });
      if (url.endsWith('/bookings') && init?.method === 'POST') {
        return jsonResponse(409, {
          error: {
            code: 'UNIT_UNAVAILABLE',
            message: 'R01 is already booked (LWW-260820-0002) for that window.',
            details: { unitId: 'unit_1', unitCode: 'R01', conflictingReferenceNo: 'LWW-260820-0002' },
          },
        });
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => expect(screen.getByRole('link', { name: 'Bookings' })).toBeInTheDocument());
    await user.click(screen.getByRole('link', { name: 'Bookings' }));
    await waitFor(() => expect(screen.getByText('New booking')).toBeInTheDocument());

    await user.type(screen.getByLabelText('Guest name'), 'Overlap Guest');
    await user.type(screen.getByLabelText('Arrival date'), '2026-08-25');
    await user.type(screen.getByLabelText('Departure date'), '2026-08-26');
    await waitFor(() => expect(screen.getByLabelText('R01 — Room 1')).toBeInTheDocument());
    await user.click(screen.getByLabelText('R01 — Room 1'));
    await user.click(screen.getByRole('button', { name: 'Create booking' }));

    expect(await screen.findByText(/R01 is already booked \(LWW-260820-0002\)/)).toBeInTheDocument();
    expect(screen.queryByText(/^Created/)).not.toBeInTheDocument();
  });

  it('switches to the fixed day-tour block and hides the departure date field for DAY_TOUR', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: cashierUser });
      if (url.endsWith('/units')) return jsonResponse(200, { units });
      if (url.endsWith('/unit-types')) return jsonResponse(200, { unitTypes });
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => expect(screen.getByRole('link', { name: 'Bookings' })).toBeInTheDocument());
    await user.click(screen.getByRole('link', { name: 'Bookings' }));
    await waitFor(() => expect(screen.getByText('New booking')).toBeInTheDocument());

    expect(screen.getByLabelText('Departure date')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Type'), 'DAY_TOUR');
    expect(screen.queryByLabelText('Departure date')).not.toBeInTheDocument();
    expect(screen.getByText(/Fixed block: 9:00 AM/)).toBeInTheDocument();
  });

  const readyBookingSearchResult = {
    id: 'booking_1',
    referenceNo: 'LWW-260823-0003',
    guestName: 'Arrival Guest',
    type: 'OVERNIGHT',
    status: 'PENDING',
    startAt: '2026-08-23T06:00:00.000Z',
    endAt: '2026-08-24T04:00:00.000Z',
    units: [{ unitId: 'unit_1', rate: 2500, unit: { id: 'unit_1', code: 'R01', name: 'Room 1', status: 'READY' } }],
  };

  it('checks in a booking straight from a Ready unit', async () => {
    const user = userEvent.setup();
    let checkinCalled = false;

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: cashierUser });
      if (url.endsWith('/units')) return jsonResponse(200, { units });
      if (url.endsWith('/unit-types')) return jsonResponse(200, { unitTypes });
      if (url.includes('/bookings?search=')) return jsonResponse(200, { bookings: [readyBookingSearchResult] });
      if (url.endsWith('/bookings/booking_1/checkin') && init?.method === 'POST') {
        checkinCalled = true;
        expect(JSON.parse(init.body as string)).toEqual({});
        return jsonResponse(200, { booking: { ...readyBookingSearchResult, status: 'CHECKED_IN' } });
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => expect(screen.getByRole('link', { name: 'Bookings' })).toBeInTheDocument());
    await user.click(screen.getByRole('link', { name: 'Bookings' }));
    await waitFor(() => expect(screen.getByText('Check-in / check-out')).toBeInTheDocument());

    await user.type(screen.getByLabelText('Booking reference or guest name'), 'Arrival Guest');
    await user.click(screen.getByRole('button', { name: 'Look up' }));

    await user.click(await screen.findByText('Arrival Guest'));
    await user.click(await screen.findByRole('button', { name: 'Confirm arrival' }));

    expect(await screen.findByText('LWW-260823-0003 checked in — Arrival Guest.')).toBeInTheDocument();
    expect(checkinCalled).toBe(true);
  });

  it('warns rather than blocks when the unit is not yet Ready, then checks in on acknowledge', async () => {
    const user = userEvent.setup();
    const dirtyResult = {
      ...readyBookingSearchResult,
      units: [{ unitId: 'unit_1', rate: 2500, unit: { id: 'unit_1', code: 'R01', name: 'Room 1', status: 'VACANT_DIRTY' } }],
    };
    let secondAttemptBody: unknown = null;

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: cashierUser });
      if (url.endsWith('/units')) return jsonResponse(200, { units });
      if (url.endsWith('/unit-types')) return jsonResponse(200, { unitTypes });
      if (url.includes('/bookings?search=')) return jsonResponse(200, { bookings: [dirtyResult] });
      if (url.endsWith('/bookings/booking_1/checkin') && init?.method === 'POST') {
        const body = JSON.parse(init.body as string) as { acknowledgeNotReady?: boolean };
        if (!body.acknowledgeNotReady) {
          return jsonResponse(409, {
            error: {
              code: 'UNIT_NOT_READY',
              message: 'R01 is not Ready yet (currently VACANT_DIRTY) — confirm to check in anyway.',
              details: { unitId: 'unit_1', unitCode: 'R01', unitStatus: 'VACANT_DIRTY' },
            },
          });
        }
        secondAttemptBody = body;
        return jsonResponse(200, { booking: { ...dirtyResult, status: 'CHECKED_IN' } });
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => expect(screen.getByRole('link', { name: 'Bookings' })).toBeInTheDocument());
    await user.click(screen.getByRole('link', { name: 'Bookings' }));
    await waitFor(() => expect(screen.getByText('Check-in / check-out')).toBeInTheDocument());

    await user.type(screen.getByLabelText('Booking reference or guest name'), 'Arrival Guest');
    await user.click(screen.getByRole('button', { name: 'Look up' }));
    await user.click(await screen.findByText('Arrival Guest'));
    await user.click(await screen.findByRole('button', { name: 'Confirm arrival' }));

    expect(await screen.findByText(/R01 is not Ready yet/)).toBeInTheDocument();
    expect(screen.queryByText(/checked in —/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Check in anyway' }));

    expect(await screen.findByText('LWW-260823-0003 checked in — Arrival Guest.')).toBeInTheDocument();
    expect(secondAttemptBody).toEqual({ acknowledgeNotReady: true });
  });

  it('blocks check-in with a hard error when the unit is already occupied by another booking', async () => {
    const user = userEvent.setup();
    const occupiedResult = {
      ...readyBookingSearchResult,
      units: [{ unitId: 'unit_1', rate: 2500, unit: { id: 'unit_1', code: 'R01', name: 'Room 1', status: 'OCCUPIED' } }],
    };

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: cashierUser });
      if (url.endsWith('/units')) return jsonResponse(200, { units });
      if (url.endsWith('/unit-types')) return jsonResponse(200, { unitTypes });
      if (url.includes('/bookings?search=')) return jsonResponse(200, { bookings: [occupiedResult] });
      if (url.endsWith('/bookings/booking_1/checkin') && init?.method === 'POST') {
        return jsonResponse(409, {
          error: {
            code: 'UNIT_UNAVAILABLE',
            message: 'R01 is already occupied by another booking.',
            details: { unitId: 'unit_1', unitCode: 'R01', reason: 'OCCUPIED' },
          },
        });
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => expect(screen.getByRole('link', { name: 'Bookings' })).toBeInTheDocument());
    await user.click(screen.getByRole('link', { name: 'Bookings' }));
    await waitFor(() => expect(screen.getByText('Check-in / check-out')).toBeInTheDocument());

    await user.type(screen.getByLabelText('Booking reference or guest name'), 'Arrival Guest');
    await user.click(screen.getByRole('button', { name: 'Look up' }));
    await user.click(await screen.findByText('Arrival Guest'));
    await user.click(await screen.findByRole('button', { name: 'Confirm arrival' }));

    expect(await screen.findByText(/R01 cannot be checked in right now/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Check in anyway' })).not.toBeInTheDocument();
  });

  it('checks out a currently checked-in booking with an unconditional status flip', async () => {
    const user = userEvent.setup();
    const checkedInResult = {
      ...readyBookingSearchResult,
      status: 'CHECKED_IN',
      units: [{ unitId: 'unit_1', rate: 2500, unit: { id: 'unit_1', code: 'R01', name: 'Room 1', status: 'OCCUPIED' } }],
    };
    let checkoutBody: unknown = null;

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: cashierUser });
      if (url.endsWith('/units')) return jsonResponse(200, { units });
      if (url.endsWith('/unit-types')) return jsonResponse(200, { unitTypes });
      if (url.includes('/bookings?search=')) return jsonResponse(200, { bookings: [checkedInResult] });
      if (url.endsWith('/bookings/booking_1/checkout') && init?.method === 'POST') {
        checkoutBody = JSON.parse(init.body as string);
        return jsonResponse(200, { booking: { ...checkedInResult, status: 'CHECKED_OUT' } });
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => expect(screen.getByRole('link', { name: 'Bookings' })).toBeInTheDocument());
    await user.click(screen.getByRole('link', { name: 'Bookings' }));
    await waitFor(() => expect(screen.getByText('Check-in / check-out')).toBeInTheDocument());

    await user.type(screen.getByLabelText('Booking reference or guest name'), 'Arrival Guest');
    await user.click(screen.getByRole('button', { name: 'Look up' }));
    await user.click(await screen.findByText('Arrival Guest'));
    // No balance/payment gate — the button is available unconditionally
    // for a CHECKED_IN booking.
    await user.click(await screen.findByRole('button', { name: 'Confirm departure (check out)' }));

    expect(await screen.findByText('LWW-260823-0003 checked out — Arrival Guest.')).toBeInTheDocument();
    expect(checkoutBody).toEqual({});
  });
});
