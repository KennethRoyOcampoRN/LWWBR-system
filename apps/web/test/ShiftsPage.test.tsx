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

// Strips the query string so a single check like `path(url).endsWith('/time-logs')`
// matches both the self-scoped "my recent time logs" fetch and the audit
// view's `/time-logs?from=...&to=...` fetch, without needing two branches
// in every test's fetch mock.
function path(urlStr: string): string {
  return urlStr.split('?')[0]!;
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

// Default handlers a shift:manage fixture needs so its always-rendered
// sections (Flagged Entries, All time logs) don't error out when a test
// isn't exercising them directly.
function shiftManagerDefaults(url: string, init?: RequestInit): Promise<Response> | undefined {
  if (path(url).endsWith('/time-logs/flagged')) return jsonResponse(200, { timeLogs: [] });
  if (path(url).endsWith('/shifts/assignable-users')) return jsonResponse(200, { users: [] });
  if (path(url).endsWith('/dtr/check-location') && init?.method === 'POST') {
    return jsonResponse(200, { flagged: false, reason: null });
  }
  return undefined;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ShiftsPage', () => {
  it('clocking in requires a photo — no request is made without one', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: shiftManagerUser });
      const defaulted = shiftManagerDefaults(url);
      if (defaulted) return defaulted;
      if (path(url).endsWith('/time-logs')) return jsonResponse(200, { timeLogs: [] });
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
      const defaulted = shiftManagerDefaults(url, init);
      if (defaulted) return defaulted;
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
            clockInLat: null,
            clockInLng: null,
            clockOutLat: null,
            clockOutLng: null,
            clockInFlagged: true,
            clockOutFlagged: false,
            clockInFlagReason: 'NO_LOCATION',
            clockOutFlagReason: null,
            reviewedAt: null,
            reviewNote: null,
            user: { id: 'user_1', fullName: 'POC Housekeeping (Demo)' },
          },
        });
      }
      if (path(url).endsWith('/time-logs') && (!init || init.method === undefined)) {
        return jsonResponse(200, { timeLogs: clockInCalled ? [{
          id: 'log_1', userId: 'user_1', clockInAt: new Date().toISOString(), clockOutAt: null,
          clockInPhoto: null, clockOutPhoto: null, clockInLat: null, clockInLng: null,
          clockOutLat: null, clockOutLng: null, clockInFlagged: true, clockOutFlagged: false,
          clockInFlagReason: 'NO_LOCATION', clockOutFlagReason: null,
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

  // Client follow-up, 2026-09-13: warn in the moment, not just flag
  // silently. Cancelling the window.confirm dialog must abort before any
  // photo upload or clock-in call happens.
  it('warns when the pre-check comes back flagged, and Cancel aborts without submitting', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    let clockInCalled = false;
    let uploadCalled = false;

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: shiftManagerUser });
      if (path(url).endsWith('/time-logs/flagged')) return jsonResponse(200, { timeLogs: [] });
      if (path(url).endsWith('/shifts/assignable-users')) return jsonResponse(200, { users: [] });
      if (path(url).endsWith('/dtr/check-location') && init?.method === 'POST') {
        return jsonResponse(200, { flagged: true, reason: 'OUTSIDE_ALL_GEOFENCES' });
      }
      if (url.endsWith('/restday-requests')) return jsonResponse(200, { restDayRequests: [] });
      if (path(url).endsWith('/time-logs')) return jsonResponse(200, { timeLogs: [] });
      if (url.endsWith('/files') && init?.method === 'POST') {
        uploadCalled = true;
        return jsonResponse(201, { file: { id: 'file_1' } });
      }
      if (url.endsWith('/time-logs/clock-in') && init?.method === 'POST') {
        clockInCalled = true;
        return jsonResponse(201, { timeLog: {} });
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState({}, '', '/shifts');

    render(<App />);

    await waitFor(() => expect(screen.getByLabelText('Clock-in selfie')).toBeInTheDocument());
    const file = new File(['x'], 'selfie.jpg', { type: 'image/jpeg' });
    await user.upload(screen.getByLabelText('Clock-in selfie'), file);

    await waitFor(() => expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('outside a known work location')));
    expect(uploadCalled).toBe(false);
    expect(clockInCalled).toBe(false);
  });

  it('warns when the pre-check comes back flagged, and Continue submits normally', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    let clockInCalled = false;

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: shiftManagerUser });
      if (path(url).endsWith('/time-logs/flagged')) return jsonResponse(200, { timeLogs: [] });
      if (path(url).endsWith('/shifts/assignable-users')) return jsonResponse(200, { users: [] });
      if (path(url).endsWith('/dtr/check-location') && init?.method === 'POST') {
        return jsonResponse(200, { flagged: true, reason: 'OUTSIDE_ALL_GEOFENCES' });
      }
      if (url.endsWith('/restday-requests')) return jsonResponse(200, { restDayRequests: [] });
      if (url.endsWith('/files') && init?.method === 'POST') {
        return jsonResponse(201, { file: { id: 'file_1' } });
      }
      if (url.endsWith('/time-logs/clock-in') && init?.method === 'POST') {
        clockInCalled = true;
        return jsonResponse(201, {
          timeLog: {
            id: 'log_1', userId: 'user_1', clockInAt: new Date().toISOString(), clockOutAt: null,
            clockInPhoto: null, clockOutPhoto: null, clockInLat: 0, clockInLng: 0,
            clockOutLat: null, clockOutLng: null, clockInFlagged: true, clockOutFlagged: false,
            clockInFlagReason: 'OUTSIDE_ALL_GEOFENCES', clockOutFlagReason: null,
            reviewedAt: null, reviewNote: null, user: { id: 'user_1', fullName: 'POC Housekeeping (Demo)' },
          },
        });
      }
      if (path(url).endsWith('/time-logs')) {
        return jsonResponse(200, { timeLogs: clockInCalled ? [{
          id: 'log_1', userId: 'user_1', clockInAt: new Date().toISOString(), clockOutAt: null,
          clockInPhoto: null, clockOutPhoto: null, clockInLat: 0, clockInLng: 0,
          clockOutLat: null, clockOutLng: null, clockInFlagged: true, clockOutFlagged: false,
          clockInFlagReason: 'OUTSIDE_ALL_GEOFENCES', clockOutFlagReason: null,
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

    await waitFor(() => expect(window.confirm).toHaveBeenCalled());
    await waitFor(() => expect(clockInCalled).toBe(true));
  });

  it('does not warn when the pre-check comes back clear', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm');
    let clockInCalled = false;

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: shiftManagerUser });
      const defaulted = shiftManagerDefaults(url, init);
      if (defaulted) return defaulted;
      if (url.endsWith('/restday-requests')) return jsonResponse(200, { restDayRequests: [] });
      if (url.endsWith('/files') && init?.method === 'POST') {
        return jsonResponse(201, { file: { id: 'file_1' } });
      }
      if (url.endsWith('/time-logs/clock-in') && init?.method === 'POST') {
        clockInCalled = true;
        return jsonResponse(201, { timeLog: {} });
      }
      if (path(url).endsWith('/time-logs')) return jsonResponse(200, { timeLogs: [] });
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState({}, '', '/shifts');

    render(<App />);

    await waitFor(() => expect(screen.getByLabelText('Clock-in selfie')).toBeInTheDocument());
    const file = new File(['x'], 'selfie.jpg', { type: 'image/jpeg' });
    await user.upload(screen.getByLabelText('Clock-in selfie'), file);

    await waitFor(() => expect(clockInCalled).toBe(true));
    expect(window.confirm).not.toHaveBeenCalled();
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

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: approverUser });
      const defaulted = shiftManagerDefaults(url, init);
      if (defaulted) return defaulted;
      if (path(url).endsWith('/time-logs')) return jsonResponse(200, { timeLogs: [] });
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

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: shiftManagerUser });
      const defaulted = shiftManagerDefaults(url, init);
      if (defaulted) return defaulted;
      if (path(url).endsWith('/time-logs')) return jsonResponse(200, { timeLogs: [] });
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

  // Explicit re-confirmation after the roster section was removed
  // (spec.md §13 decision 9): shift:manage still gates Flagged Entries
  // review on its own, independent of the roster UI it used to also
  // gate — this exercises the real review action end to end, and now
  // also the map + flag-reason display added in this slice.
  it('a shift:manage holder sees Flagged Entries with a map and flag reason, and can mark an entry reviewed', async () => {
    const user = userEvent.setup();
    let reviewCalled = false;
    const flaggedEntry = {
      id: 'log_1',
      userId: 'user_2',
      clockInAt: '2026-09-20T06:00:00.000Z',
      clockOutAt: null,
      clockInPhoto: { id: 'file_1', filename: 'selfie-in.jpg', url: 'https://storage.example/signed/selfie-in.jpg' },
      clockOutPhoto: null,
      clockInLat: 13.75,
      clockInLng: 121.05,
      clockOutLat: null,
      clockOutLng: null,
      clockInFlagged: true,
      clockOutFlagged: false,
      clockInFlagReason: 'OUTSIDE_ALL_GEOFENCES',
      clockOutFlagReason: null,
      reviewedAt: null,
      reviewNote: null,
      user: { id: 'user_2', fullName: 'Room Attendant (Demo)' },
    };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: shiftManagerUser });
      if (path(url).endsWith('/time-logs/flagged')) return jsonResponse(200, { timeLogs: reviewCalled ? [] : [flaggedEntry] });
      if (path(url).endsWith('/shifts/assignable-users')) return jsonResponse(200, { users: [] });
      if (path(url).endsWith('/time-logs')) return jsonResponse(200, { timeLogs: [] });
      if (url.endsWith('/restday-requests')) return jsonResponse(200, { restDayRequests: [] });
      if (url.endsWith('/time-logs/log_1/review') && init?.method === 'POST') {
        reviewCalled = true;
        return jsonResponse(200, { timeLog: { ...flaggedEntry, reviewedAt: new Date().toISOString() } });
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState({}, '', '/shifts');

    render(<App />);

    await waitFor(() => expect(screen.getByText('Flagged time entries')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('View clock-in photo')).toBeInTheDocument());
    expect(screen.getByText('Clock-in: Outside every configured location')).toBeInTheDocument();
    const map = screen.getByTitle('Room Attendant (Demo) clock-in location') as HTMLIFrameElement;
    expect(map.tagName).toBe('IFRAME');
    expect(map.src).toContain('openstreetmap.org/export/embed.html');
    expect(map.src).toContain('marker=13.75');

    await user.click(screen.getByRole('button', { name: 'Mark reviewed' }));
    await waitFor(() => expect(reviewCalled).toBe(true));
    await waitFor(() => expect(screen.getByText('No flagged entries.')).toBeInTheDocument());
  });

  it('a shift:read-only holder does not see Flagged Entries, All time logs, or the geofence panel', async () => {
    const readOnlyUser = { ...shiftManagerUser, permissions: { 'shift:read': 'ALL', 'restday:request': 'ALL' } };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: readOnlyUser });
      if (path(url).endsWith('/time-logs')) return jsonResponse(200, { timeLogs: [] });
      if (url.endsWith('/restday-requests')) return jsonResponse(200, { restDayRequests: [] });
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState({}, '', '/shifts');

    render(<App />);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Time clock' })).toBeInTheDocument());
    expect(screen.queryByText('Flagged time entries')).not.toBeInTheDocument();
    expect(screen.queryByText('All time logs')).not.toBeInTheDocument();
    expect(screen.queryByText('DTR work locations')).not.toBeInTheDocument();
  });

  // Client follow-up, 2026-09-13: a general audit view beyond the
  // flagged queue, for a shift:manage holder.
  it('a shift:manage holder sees All time logs with every entry (not just flagged), including a normal one', async () => {
    const normalLog = {
      id: 'log_2',
      userId: 'user_2',
      clockInAt: '2026-09-10T06:00:00.000Z',
      clockOutAt: '2026-09-10T14:00:00.000Z',
      clockInPhoto: { id: 'file_3', filename: 'in.jpg', url: 'https://storage.example/signed/in.jpg' },
      clockOutPhoto: { id: 'file_4', filename: 'out.jpg', url: 'https://storage.example/signed/out.jpg' },
      clockInLat: 13.75,
      clockInLng: 121.05,
      clockOutLat: 13.7501,
      clockOutLng: 121.0501,
      clockInFlagged: false,
      clockOutFlagged: false,
      clockInFlagReason: null,
      clockOutFlagReason: null,
      reviewedAt: null,
      reviewNote: null,
      user: { id: 'user_2', fullName: 'Room Attendant (Demo)' },
    };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: shiftManagerUser });
      if (path(url).endsWith('/time-logs/flagged')) return jsonResponse(200, { timeLogs: [] });
      if (path(url).endsWith('/shifts/assignable-users')) return jsonResponse(200, { users: [{ id: 'user_2', fullName: 'Room Attendant (Demo)' }] });
      if (path(url).endsWith('/time-logs')) return jsonResponse(200, { timeLogs: [normalLog] });
      if (url.endsWith('/restday-requests')) return jsonResponse(200, { restDayRequests: [] });
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState({}, '', '/shifts');

    render(<App />);

    await waitFor(() => expect(screen.getByText('All time logs')).toBeInTheDocument());
    const auditSection = screen.getByText('All time logs').closest('section') as HTMLElement;
    await waitFor(() => expect(within(auditSection).getAllByText('Room Attendant (Demo)').length).toBeGreaterThan(0));
    expect(within(auditSection).getByText('Normal')).toBeInTheDocument();
    const maps = within(auditSection).getAllByTitle(/Room Attendant \(Demo\) clock-(in|out) location/);
    expect(maps).toHaveLength(2);
    // Sent from GET /shifts/assignable-users, the audit view's employee filter.
    expect(within(auditSection).getByRole('combobox', { name: 'Employee' })).toBeInTheDocument();
  });

  it('a system:configure holder sees the DTR work-locations panel; a shift:manage-only holder does not', async () => {
    const adminUser = {
      ...shiftManagerUser,
      roles: ['SYSTEM_ADMIN'],
      permissions: { ...shiftManagerUser.permissions, 'system:configure': 'ALL' },
    };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: adminUser });
      const defaulted = shiftManagerDefaults(url, init);
      if (defaulted) return defaulted;
      if (path(url).endsWith('/time-logs')) return jsonResponse(200, { timeLogs: [] });
      if (url.endsWith('/restday-requests')) return jsonResponse(200, { restDayRequests: [] });
      if (path(url).endsWith('/dtr/geofences')) return jsonResponse(200, { geofences: [] });
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState({}, '', '/shifts');

    render(<App />);

    await waitFor(() => expect(screen.getByText('DTR work locations')).toBeInTheDocument());
  });

  // Client follow-up, 2026-09-13: multiple named geofences, add/edit/
  // delete — replacing the single geofence form.
  it('a system:configure holder can add, edit, and delete named work locations', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const adminUser = {
      ...shiftManagerUser,
      roles: ['SYSTEM_ADMIN'],
      permissions: { ...shiftManagerUser.permissions, 'system:configure': 'ALL' },
    };
    let geofences: Array<Record<string, unknown>> = [];
    let deleteCalled = false;

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: adminUser });
      const defaulted = shiftManagerDefaults(url, init);
      if (defaulted) return defaulted;
      if (path(url).endsWith('/time-logs')) return jsonResponse(200, { timeLogs: [] });
      if (url.endsWith('/restday-requests')) return jsonResponse(200, { restDayRequests: [] });
      if (path(url).endsWith('/dtr/geofences') && (!init || init.method === undefined)) {
        return jsonResponse(200, { geofences });
      }
      if (path(url).endsWith('/dtr/geofences') && init?.method === 'POST') {
        const body = JSON.parse(init.body as string);
        expect(body).toMatchObject({ name: 'Main Resort' });
        const created = { id: 'geo_1', ...body };
        geofences = [created];
        return jsonResponse(201, { geofence: created });
      }
      if (path(url).endsWith('/dtr/geofences/geo_1') && init?.method === 'PATCH') {
        const body = JSON.parse(init.body as string);
        const updated = { id: 'geo_1', ...body };
        geofences = [updated];
        return jsonResponse(200, { geofence: updated });
      }
      if (path(url).endsWith('/dtr/geofences/geo_1') && init?.method === 'DELETE') {
        deleteCalled = true;
        geofences = [];
        return jsonResponse(204, undefined);
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState({}, '', '/shifts');

    render(<App />);

    await waitFor(() => expect(screen.getByText('DTR work locations')).toBeInTheDocument());

    await user.type(screen.getByLabelText('Name'), 'Main Resort');
    await user.type(screen.getByLabelText('Center latitude'), '13.75');
    await user.type(screen.getByLabelText('Center longitude'), '121.05');
    await user.type(screen.getByLabelText('Radius (meters)'), '200');
    await user.click(screen.getByRole('button', { name: 'Add location' }));

    await waitFor(() => expect(screen.getByText('Main Resort')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleteCalled).toBe(true));
  });

  // Client decision, 2026-09-12 (spec.md §13 decision 9): the Shift
  // roster section is gone from this page — scheduling is manual,
  // outside the app. Time clock still renders first (client follow-up,
  // same day) with no "Shift roster" heading anywhere in the DOM.
  it('renders the Time clock section with no Shift roster section', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: shiftManagerUser });
      const defaulted = shiftManagerDefaults(url, init);
      if (defaulted) return defaulted;
      if (path(url).endsWith('/time-logs')) return jsonResponse(200, { timeLogs: [] });
      if (url.endsWith('/restday-requests')) return jsonResponse(200, { restDayRequests: [] });
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState({}, '', '/shifts');

    render(<App />);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Time clock' })).toBeInTheDocument());
    expect(screen.queryByRole('heading', { name: 'Shift roster' })).not.toBeInTheDocument();
    expect(screen.queryByText('Add a shift')).not.toBeInTheDocument();
  });

  // capture="user" is a mobile-browser hint, not a guarantee — asserted
  // as an attribute on both inputs so a future edit can't silently drop
  // it, not as proof it opens the camera (that's not testable in jsdom).
  it('both clock-in and clock-out selfie inputs request the front-facing camera via capture="user"', async () => {
    const openLog = {
      id: 'log_1', userId: 'user_1', clockInAt: new Date().toISOString(), clockOutAt: null,
      clockInPhoto: null, clockOutPhoto: null, clockInLat: null, clockInLng: null,
      clockOutLat: null, clockOutLng: null, clockInFlagged: false, clockOutFlagged: false,
      clockInFlagReason: null, clockOutFlagReason: null,
      reviewedAt: null, reviewNote: null, user: { id: 'user_1', fullName: 'POC Housekeeping (Demo)' },
    };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: shiftManagerUser });
      const defaulted = shiftManagerDefaults(url, init);
      if (defaulted) return defaulted;
      if (path(url).endsWith('/time-logs')) return jsonResponse(200, { timeLogs: [openLog] });
      if (url.endsWith('/restday-requests')) return jsonResponse(200, { restDayRequests: [] });
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState({}, '', '/shifts');

    render(<App />);

    await waitFor(() => expect(screen.getByLabelText('Clock-out selfie')).toBeInTheDocument());
    expect(screen.getByLabelText('Clock-out selfie')).toHaveAttribute('capture', 'user');
  });

  it('the clock-in selfie input also requests the front-facing camera via capture="user"', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: shiftManagerUser });
      const defaulted = shiftManagerDefaults(url, init);
      if (defaulted) return defaulted;
      if (path(url).endsWith('/time-logs')) return jsonResponse(200, { timeLogs: [] });
      if (url.endsWith('/restday-requests')) return jsonResponse(200, { restDayRequests: [] });
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState({}, '', '/shifts');

    render(<App />);

    await waitFor(() => expect(screen.getByLabelText('Clock-in selfie')).toBeInTheDocument());
    expect(screen.getByLabelText('Clock-in selfie')).toHaveAttribute('capture', 'user');
  });

  // UI feedback, 2026-09-12: the raw file input ("Choose File"/"No file
  // chosen") is now hidden — a real "Clock in"/"Clock out" button is
  // what the person sees and taps, opening the camera behind it via the
  // input's own ref. Confirms the button is what's visibly presented,
  // and that tapping it actually reaches the hidden input.
  it('shows a "Clock in" button (not a raw file input) that opens the camera picker when tapped', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: shiftManagerUser });
      const defaulted = shiftManagerDefaults(url, init);
      if (defaulted) return defaulted;
      if (path(url).endsWith('/time-logs')) return jsonResponse(200, { timeLogs: [] });
      if (url.endsWith('/restday-requests')) return jsonResponse(200, { restDayRequests: [] });
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState({}, '', '/shifts');

    const clickSpy = vi.spyOn(HTMLInputElement.prototype, 'click');
    render(<App />);

    const button = await screen.findByRole('button', { name: 'Clock in' });
    const input = screen.getByLabelText('Clock-in selfie') as HTMLInputElement;
    expect(input).toHaveClass('sr-only');

    await user.click(button);
    expect(clickSpy).toHaveBeenCalled();
  });

  it('shows a "Clock out" button (not a raw file input) once already clocked in', async () => {
    const user = userEvent.setup();
    const openLog = {
      id: 'log_1', userId: 'user_1', clockInAt: new Date().toISOString(), clockOutAt: null,
      clockInPhoto: null, clockOutPhoto: null, clockInLat: null, clockInLng: null,
      clockOutLat: null, clockOutLng: null, clockInFlagged: false, clockOutFlagged: false,
      clockInFlagReason: null, clockOutFlagReason: null,
      reviewedAt: null, reviewNote: null, user: { id: 'user_1', fullName: 'POC Housekeeping (Demo)' },
    };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: shiftManagerUser });
      const defaulted = shiftManagerDefaults(url, init);
      if (defaulted) return defaulted;
      if (path(url).endsWith('/time-logs')) return jsonResponse(200, { timeLogs: [openLog] });
      if (url.endsWith('/restday-requests')) return jsonResponse(200, { restDayRequests: [] });
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState({}, '', '/shifts');

    const clickSpy = vi.spyOn(HTMLInputElement.prototype, 'click');
    render(<App />);

    const button = await screen.findByRole('button', { name: 'Clock out' });
    const input = screen.getByLabelText('Clock-out selfie') as HTMLInputElement;
    expect(input).toHaveClass('sr-only');

    await user.click(button);
    expect(clickSpy).toHaveBeenCalled();
  });
});
