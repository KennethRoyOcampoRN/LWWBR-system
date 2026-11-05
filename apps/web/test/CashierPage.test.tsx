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

const cashierUser = {
  id: 'user_1',
  employeeCode: 'LWW-030',
  fullName: 'Cashier (Demo)',
  email: null,
  department: 'FRONT_OFFICE',
  mustChangePassword: false,
  roles: ['CASHIER'],
  permissions: { 'receipt:issue': 'ALL' },
};

const readyUnit = { id: 'unit_1', code: 'R01', name: 'Room 1', type: 'ROOM', status: 'READY' };

describe('CashierPage — the Cashier-tab booking picker and pre-arrival flow', () => {
  it('defaults to the in-house + pre-arrival scope and shows each booking\'s own status', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: cashierUser });
      if (url.includes('/bookings/search')) {
        expect(url).toContain('scope=in_house');
        return jsonResponse(200, {
          bookings: [
            {
              id: 'booking_1',
              referenceNo: 'EXT-200',
              guestName: 'Jane Dela Cruz',
              status: 'CONFIRMED',
              arrivalDate: '2026-11-10T00:00:00.000Z',
              departureDate: '2026-11-12T00:00:00.000Z',
              endAt: null,
              units: [{ code: 'R01', name: 'Room 1' }],
            },
          ],
        });
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState({}, '', '/cashier');

    render(<App />);

    await waitFor(() => expect(screen.getByText('Jane Dela Cruz')).toBeInTheDocument());
    expect(screen.getByText('Booked (not arrived)')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Jane Dela Cruz/ })).toHaveAttribute('href', '/billing/booking_1');
  });

  it('creates a pre-arrival booking and navigates to its billing page', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: cashierUser });
      if (url.includes('/bookings/search')) return jsonResponse(200, { bookings: [] });
      if (url.endsWith('/units') && (!init || init.method === undefined)) return jsonResponse(200, { units: [readyUnit] });
      if (url.endsWith('/bookings/pre-arrival') && init?.method === 'POST') {
        const body = JSON.parse(init.body as string);
        expect(body).toMatchObject({ guestName: 'Jane Dela Cruz', externalBookingId: 'EXT-200', unitId: 'unit_1' });
        return jsonResponse(201, { booking: { id: 'booking_1', status: 'CONFIRMED' } });
      }
      if (url.endsWith('/bookings/booking_1') && !init?.method) return jsonResponse(200, { booking: { id: 'booking_1', referenceNo: 'EXT-200', guestName: 'Jane Dela Cruz', status: 'CONFIRMED', units: [] } });
      if (url.endsWith('/bookings/booking_1/folio-charges') && !init?.method) return jsonResponse(200, { folioCharges: [] });
      if (url.endsWith('/bookings/booking_1/unsettled-fnb-charges')) return jsonResponse(200, { charges: [] });
      if (url.endsWith('/bookings/booking_1/receipts/preview') && init?.method === 'POST') {
        return jsonResponse(200, {
          resort: { name: 'r', address: 'a', cellNo: null, contactNo: null, website: null, facebookUrl: null, logo: null },
          guest: { name: 'Jane Dela Cruz', address: null, contactNo: null, email: null },
          lines: [],
          deductions: [],
          grandTotal: 0,
          totalDeductions: 0,
          totalAmountDue: 0,
        });
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState({}, '', '/cashier');

    render(<App />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'New pre-arrival booking' })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'New pre-arrival booking' }));

    await user.type(screen.getByLabelText('Guest name'), 'Jane Dela Cruz');
    await user.type(screen.getByLabelText('Booking ID (from the external booking website)'), 'EXT-200');
    await user.type(screen.getByLabelText('Check-in date'), '2026-11-10');
    await user.type(screen.getByLabelText('Check-out date'), '2026-11-12');
    await waitFor(() => expect(screen.getByRole('option', { name: /R01/ })).toBeInTheDocument());
    await user.selectOptions(screen.getByLabelText('Room (Ready only)'), 'unit_1');
    await user.click(screen.getByRole('button', { name: 'Create booking' }));

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Bill guest' })).toBeInTheDocument());
  });
});
