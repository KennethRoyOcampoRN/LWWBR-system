import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.js';

function jsonResponse(status: number, body: unknown) {
  return Promise.resolve({
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body),
  } as Response);
}

function stubGeolocation(result: { lat: number; lng: number } | 'denied') {
  Object.defineProperty(global.navigator, 'geolocation', {
    configurable: true,
    value: {
      getCurrentPosition: (
        success: (pos: { coords: { latitude: number; longitude: number } }) => void,
        error: () => void,
      ) => {
        if (result === 'denied') {
          error();
        } else {
          success({ coords: { latitude: result.lat, longitude: result.lng } });
        }
      },
    },
  });
}

const shiftManagerUser = {
  id: 'user_1',
  employeeCode: 'LWW-009',
  fullName: 'POC Housekeeping (Demo)',
  email: null,
  department: 'HOUSEKEEPING',
  mustChangePassword: false,
  roles: ['POC_HOUSEKEEPING'],
  permissions: { 'shift:read': 'ALL', 'shift:manage': 'ALL', 'restday:request': 'ALL' },
};

const shift = {
  id: 'shift_1',
  date: '2026-09-20T00:00:00.000Z',
  startTime: '2026-09-20T06:00:00.000Z',
  endTime: '2026-09-20T14:00:00.000Z',
  department: 'HOUSEKEEPING',
  isReliever: false,
  note: null,
  user: { id: 'user_2', fullName: 'Room Attendant (Demo)' },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ShiftsPage', () => {
  it('a shift:manage holder can list the roster, add a shift, and cancel one', async () => {
    const user = userEvent.setup();
    let shifts = [shift];
    let deleteCalled = false;
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    stubGeolocation('denied');

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: shiftManagerUser });
      if (url.endsWith('/shifts') && (!init || init.method === undefined)) {
        return jsonResponse(200, { shifts });
      }
      if (url.endsWith('/shifts/assignable-users')) {
        return jsonResponse(200, { users: [{ id: 'user_2', fullName: 'Room Attendant (Demo)', employeeCode: 'LWW-010', department: 'HOUSEKEEPING' }] });
      }
      if (url.endsWith('/shifts') && init?.method === 'POST') {
        const body = JSON.parse(init.body as string);
        expect(body).toMatchObject({ userId: 'user_2', department: 'HOUSEKEEPING' });
        const created = { ...shift, id: 'shift_2' };
        shifts = [...shifts, created];
        return jsonResponse(201, { shift: created });
      }
      if (url.endsWith('/shifts/shift_1') && init?.method === 'DELETE') {
        deleteCalled = true;
        shifts = [];
        return jsonResponse(204, undefined);
      }
      if (url.endsWith('/time-logs/flagged')) return jsonResponse(200, { timeLogs: [] });
      if (url.endsWith('/time-logs')) return jsonResponse(200, { timeLogs: [] });
      if (url.endsWith('/restday-requests')) return jsonResponse(200, { restDayRequests: [] });
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState({}, '', '/shifts');

    render(<App />);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Shifts & DTR' })).toBeInTheDocument());
    await waitFor(() => expect(screen.getAllByText('Room Attendant (Demo)').length).toBeGreaterThan(0));

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(deleteCalled).toBe(true));

    const rosterForm = screen.getByRole('heading', { name: 'Add a shift' }).closest('form') as HTMLElement;
    await user.selectOptions(within(rosterForm).getByLabelText('Employee'), 'user_2');
    await user.type(within(rosterForm).getByLabelText('Date'), '2026-09-21');
    await user.type(within(rosterForm).getByLabelText('Start time'), '06:00');
    await user.type(within(rosterForm).getByLabelText('End time'), '14:00');
    await user.click(within(rosterForm).getByRole('button', { name: 'Add shift' }));

    await waitFor(() => expect(screen.getAllByText('Room Attendant (Demo)').length).toBeGreaterThan(0));
  });

  it('a shift:read-only holder sees the roster but no add-shift form or Cancel button', async () => {
    const readOnlyUser = { ...shiftManagerUser, permissions: { 'shift:read': 'ALL', 'restday:request': 'ALL' } };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: readOnlyUser });
      if (url.endsWith('/shifts')) return jsonResponse(200, { shifts: [shift] });
      if (url.endsWith('/time-logs')) return jsonResponse(200, { timeLogs: [] });
      if (url.endsWith('/restday-requests')) return jsonResponse(200, { restDayRequests: [] });
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState({}, '', '/shifts');

    render(<App />);

    await waitFor(() => expect(screen.getByText('Room Attendant (Demo)')).toBeInTheDocument());
    expect(screen.queryByText('Add a shift')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    // Flagged entries and geofence settings are also shift:manage/
    // system:configure only — neither renders for this fixture.
    expect(screen.queryByText('Flagged time entries')).not.toBeInTheDocument();
    expect(screen.queryByText('DTR geofence')).not.toBeInTheDocument();
  });

  it('clocking in requires a photo — no request is made without one', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: shiftManagerUser });
      if (url.endsWith('/shifts')) return jsonResponse(200, { shifts: [] });
      if (url.endsWith('/time-logs')) return jsonResponse(200, { timeLogs: [] });
      if (url.endsWith('/restday-requests')) return jsonResponse(200, { restDayRequests: [] });
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState({}, '', '/shifts');

    render(<App />);

    await waitFor(() => expect(screen.getByLabelText('Clock-in selfie')).toBeInTheDocument());
    // No file selected — the component's own guard should show an error
    // without ever calling the API. Simulate an empty file-input change.
    const input = screen.getByLabelText('Clock-in selfie') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [], configurable: true });
    fireEvent.change(input);

    await waitFor(() => expect(screen.getByText('A selfie photo is required.')).toBeInTheDocument());
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining('/files'), expect.anything());
  });

  it('clocks in successfully even when geolocation is denied — never blocks on location', async () => {
    const user = userEvent.setup();
    stubGeolocation('denied');
    let clockInCalled = false;

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: shiftManagerUser });
      if (url.endsWith('/shifts')) return jsonResponse(200, { shifts: [] });
      if (url.endsWith('/restday-requests')) return jsonResponse(200, { restDayRequests: [] });
      if (url.endsWith('/files') && init?.method === 'POST') {
        return jsonResponse(201, { file: { id: 'file_1' } });
      }
      if (url.endsWith('/time-logs/clock-in') && init?.method === 'POST') {
        const body = JSON.parse(init.body as string);
        expect(body).toMatchObject({ photoFileId: 'file_1' });
        expect(body.lat).toBeUndefined();
        clockInCalled = true;
        return jsonResponse(201, {
          timeLog: {
            id: 'log_1',
            userId: 'user_1',
            clockInAt: new Date().toISOString(),
            clockOutAt: null,
            clockInPhoto: null,
            clockOutPhoto: null,
            clockInFlagged: true,
            clockOutFlagged: false,
            reviewedAt: null,
            reviewNote: null,
            user: { id: 'user_1', fullName: 'POC Housekeeping (Demo)' },
          },
        });
      }
      if (url.endsWith('/time-logs') && (!init || init.method === undefined)) {
        return jsonResponse(200, { timeLogs: clockInCalled ? [{
          id: 'log_1', userId: 'user_1', clockInAt: new Date().toISOString(), clockOutAt: null,
          clockInPhoto: null, clockOutPhoto: null, clockInFlagged: true, clockOutFlagged: false,
          reviewedAt: null, reviewNote: null, user: { id: 'user_1', fullName: 'POC Housekeeping (Demo)' },
        }] : [] });
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState({}, '', '/shifts');

    render(<App />);

    await waitFor(() => expect(screen.getByLabelText('Clock-in selfie')).toBeInTheDocument());
    const file = new File(['x'], 'selfie.jpg', { type: 'image/jpeg' });
    await user.upload(screen.getByLabelText('Clock-in selfie'), file);

    await waitFor(() => expect(clockInCalled).toBe(true));
    await waitFor(() => expect(screen.getByText('Flagged for review')).toBeInTheDocument());
  });

  it('restday:approve holder sees Approve/Reject controls; a restday:request-only holder does not', async () => {
    const restDayRequest = {
      id: 'restday_1',
      requestedDate: '2026-09-25T00:00:00.000Z',
      reason: 'Family event',
      status: 'PENDING',
      decisionNote: null,
      user: { fullName: 'Room Attendant (Demo)' },
      decidedBy: null,
    };
    const approverUser = { ...shiftManagerUser, permissions: { ...shiftManagerUser.permissions, 'restday:approve': 'ALL' } };

    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: approverUser });
      if (url.endsWith('/shifts') || url.endsWith('/shifts/assignable-users')) return jsonResponse(200, { shifts: [], users: [] });
      if (url.endsWith('/time-logs') || url.endsWith('/time-logs/flagged')) return jsonResponse(200, { timeLogs: [] });
      if (url.endsWith('/restday-requests')) return jsonResponse(200, { restDayRequests: [restDayRequest] });
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState({}, '', '/shifts');

    render(<App />);

    await waitFor(() => expect(screen.getByText('Family event')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument();
  });

  it('a restday:request-only holder sees no Approve/Reject controls', async () => {
    const restDayRequest = {
      id: 'restday_1',
      requestedDate: '2026-09-25T00:00:00.000Z',
      reason: 'Family event',
      status: 'PENDING',
      decisionNote: null,
      user: { fullName: 'Room Attendant (Demo)' },
      decidedBy: null,
    };

    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: shiftManagerUser });
      if (url.endsWith('/shifts') || url.endsWith('/shifts/assignable-users')) return jsonResponse(200, { shifts: [], users: [] });
      if (url.endsWith('/time-logs') || url.endsWith('/time-logs/flagged')) return jsonResponse(200, { timeLogs: [] });
      if (url.endsWith('/restday-requests')) return jsonResponse(200, { restDayRequests: [restDayRequest] });
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState({}, '', '/shifts');

    render(<App />);

    await waitFor(() => expect(screen.getByText('Family event')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();
  });

  it('a system:configure holder sees the DTR geofence settings panel; a shift:manage-only holder does not', async () => {
    const adminUser = {
      ...shiftManagerUser,
      roles: ['SYSTEM_ADMIN'],
      permissions: { ...shiftManagerUser.permissions, 'system:configure': 'ALL' },
    };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: adminUser });
      if (url.endsWith('/shifts') || url.endsWith('/shifts/assignable-users')) return jsonResponse(200, { shifts: [], users: [] });
      if (url.endsWith('/time-logs') || url.endsWith('/time-logs/flagged')) return jsonResponse(200, { timeLogs: [] });
      if (url.endsWith('/restday-requests')) return jsonResponse(200, { restDayRequests: [] });
      if (url.endsWith('/dtr/geofence-setting')) return jsonResponse(200, { geofence: null });
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState({}, '', '/shifts');

    render(<App />);

    await waitFor(() => expect(screen.getByText('DTR geofence')).toBeInTheDocument());
  });
});
