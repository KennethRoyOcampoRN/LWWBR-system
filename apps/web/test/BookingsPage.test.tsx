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

  // Redesign, 2026-08-24: check-in/check-out moved to the Unit drawer
  // (see App.smoke.test.tsx) — what remains here is the read-only,
  // property-wide "Find a booking" search this page always specifically
  // offered, now with no action buttons attached to it.
  it('finds a booking by guest name property-wide, read-only — no check-in/check-out action here anymore', async () => {
    const user = userEvent.setup();
    const searchResult = {
      id: 'booking_1',
      referenceNo: 'LWW-260823-0003',
      guestName: 'Arrival Guest',
      type: 'OVERNIGHT',
      status: 'PENDING',
      startAt: '2026-08-23T06:00:00.000Z',
      endAt: '2026-08-24T04:00:00.000Z',
      units: [{ unitId: 'unit_1', rate: 2500, unit: { id: 'unit_1', code: 'R01', name: 'Room 1', status: 'READY' } }],
    };

    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: cashierUser });
      if (url.endsWith('/units')) return jsonResponse(200, { units });
      if (url.endsWith('/unit-types')) return jsonResponse(200, { unitTypes });
      if (url.includes('/bookings?search=')) return jsonResponse(200, { bookings: [searchResult] });
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => expect(screen.getByRole('link', { name: 'Bookings' })).toBeInTheDocument());
    await user.click(screen.getByRole('link', { name: 'Bookings' }));
    await waitFor(() => expect(screen.getByText('Find a booking')).toBeInTheDocument());

    await user.type(screen.getByLabelText('Booking reference or guest name'), 'Arrival Guest');
    await user.click(screen.getByRole('button', { name: 'Look up' }));

    expect(await screen.findByText('Arrival Guest')).toBeInTheDocument();
    expect(screen.getByText('LWW-260823-0003')).toBeInTheDocument();
    expect(screen.getByText('R01')).toBeInTheDocument();
    // No action button here anymore — that moved to the Unit drawer.
    expect(screen.queryByRole('button', { name: 'Confirm arrival' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /confirm departure/i })).not.toBeInTheDocument();
  });
});
