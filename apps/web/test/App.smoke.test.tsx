import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.js';

// Realtime status updates: rather than mocking @supabase/supabase-js's
// websocket internals, mock this app's own thin wrapper so a test can
// simulate an incoming broadcast directly and assert the grid patches
// itself — exercising exactly the same code path UnitsPage uses, without
// needing a real (or fake) Supabase Realtime connection.
let capturedRealtimeHandlers: {
  onEvent: (payload: {
    entityId: string;
    actorId: string;
    at: string;
    summary: string;
    fromStatus: string;
    toStatus: string;
    version: number;
    note: string | null;
  }) => void;
  onStatusChange: (status: 'connecting' | 'connected' | 'reconnecting' | 'disabled') => void;
} | null = null;

vi.mock('../src/lib/realtime.js', () => ({
  subscribeToUnitStatusChanges: (
    onEvent: NonNullable<typeof capturedRealtimeHandlers>['onEvent'],
    onStatusChange: NonNullable<typeof capturedRealtimeHandlers>['onStatusChange'],
  ) => {
    capturedRealtimeHandlers = { onEvent, onStatusChange };
    onStatusChange('connected');
    return () => {
      capturedRealtimeHandlers = null;
    };
  },
  // NotificationBell (rendered in AppShell on every authenticated screen)
  // subscribes on mount too — not under test here, so this just needs to
  // be a well-behaved no-op rather than a missing export.
  subscribeToNotifications: (
    _userId: string,
    _department: string,
    _onEvent: unknown,
    onStatusChange: (status: 'connecting' | 'connected' | 'reconnecting' | 'disabled') => void,
  ) => {
    onStatusChange('connected');
    return () => {};
  },
  // FnbPage subscribes on mount too — real gap found adding the KPI-card
  // navigation test that's the first one in this file to actually
  // navigate into /restaurant: this vi.mock replaces the whole module,
  // so any export FnbPage imports needs a stub here or the page crashes
  // (into the ErrorBoundary, not a helpful failure) the moment it mounts.
  subscribeToFnbOrderChanges: (
    _onEvent: unknown,
    onStatusChange: (status: 'connecting' | 'connected' | 'reconnecting' | 'disabled') => void,
  ) => {
    onStatusChange('connected');
    return () => {};
  },
}));

function jsonResponse(status: number, body: unknown) {
  return Promise.resolve({
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body),
  } as Response);
}

const currentUser = {
  id: 'user_1',
  employeeCode: 'LWW-001',
  fullName: 'Resort Manager (Demo)',
  email: null,
  department: 'MANAGEMENT',
  mustChangePassword: false,
  roles: ['RESORT_MANAGER'],
  permissions: {},
};

const mustChangeUser = { ...currentUser, mustChangePassword: true };

describe('App', () => {
  // BrowserRouter reads jsdom's real window.location, which — unlike the
  // fetch stub — isn't reset between tests in the same file. Without
  // this, a test that navigated (e.g. to /change-password or /sessions)
  // leaks that URL into the next test, which then renders whatever route
  // matches it instead of starting fresh at "/".
  beforeEach(() => {
    window.history.pushState({}, '', '/');
    capturedRealtimeHandlers = null;
    // The offline-cache test below seeds localStorage directly — clear it
    // both before and after so no snapshot leaks into an unrelated test.
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the login screen when not authenticated', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'Not authenticated' } })),
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
    });
  });

  it('logs in and lands on the dashboard', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/auth/me')) {
          return jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'Not authenticated' } });
        }
        if (url.endsWith('/auth/login')) {
          return jsonResponse(200, { user: currentUser });
        }
        return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
      }),
    );

    render(<App />);

    await waitFor(() => expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument());

    await user.type(screen.getByLabelText(/employee code/i), 'LWW-001');
    await user.type(screen.getByLabelText(/password/i), 'Waku2026!');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(screen.getByText(/Welcome, Resort Manager \(Demo\)/i)).toBeInTheDocument();
    });
  });

  it('forces a password change before the dashboard is reachable when mustChangePassword is set', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/auth/me')) {
          return jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'Not authenticated' } });
        }
        if (url.endsWith('/auth/login')) {
          return jsonResponse(200, { user: mustChangeUser });
        }
        return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
      }),
    );

    render(<App />);

    await waitFor(() => expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument());
    await user.type(screen.getByLabelText(/employee code/i), 'LWW-001');
    await user.type(screen.getByLabelText(/password/i), 'temp-password');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /change your password/i })).toBeInTheDocument();
    });
    expect(screen.queryByText(/Welcome, Resort Manager/i)).not.toBeInTheDocument();
  });

  it('lists sessions for any authenticated user and revokes one', async () => {
    const user = userEvent.setup();
    const sessions = [
      { id: 'session_this', ip: '1.1.1.1', userAgent: 'This tab', createdAt: '2026-08-22T00:00:00Z', expiresAt: '2026-08-29T00:00:00Z' },
      { id: 'session_other', ip: '2.2.2.2', userAgent: 'Incognito tab', createdAt: '2026-08-22T00:01:00Z', expiresAt: '2026-08-29T00:01:00Z' },
    ];
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) {
        return jsonResponse(200, { user: currentUser });
      }
      if (url.endsWith('/auth/sessions')) {
        return jsonResponse(200, { sessions });
      }
      if (url.endsWith('/session_other/revoke')) {
        return jsonResponse(204, undefined);
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => expect(screen.getByText(/Welcome, Resort Manager/i)).toBeInTheDocument());

    // Sessions is self-service — visible in nav even though currentUser
    // has no permissions at all (unlike Users/Roles, which do require
    // one and are correctly absent here).
    expect(screen.queryByRole('link', { name: 'Users' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: 'Sessions' }));

    await waitFor(() => expect(screen.getByText('2.2.2.2')).toBeInTheDocument());
    expect(screen.getByText('1.1.1.1')).toBeInTheDocument();

    const revokeButtons = screen.getAllByRole('button', { name: /revoke/i });
    await user.click(revokeButtons[1] as HTMLElement);

    await waitFor(() => expect(screen.queryByText('2.2.2.2')).not.toBeInTheDocument());
    expect(screen.getByText('1.1.1.1')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/auth/sessions/session_other/revoke'), expect.anything());
  });

  it('shows a live countdown on a 429 and re-enables sign-in once it clears', async () => {
    const user = userEvent.setup();
    const retryAt = new Date(Date.now() + 1200).toISOString();
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/auth/me')) {
          return jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'Not authenticated' } });
        }
        if (url.endsWith('/auth/login')) {
          return jsonResponse(429, {
            error: { code: 'RATE_LIMITED', message: 'Too many login attempts.', details: { retryAt } },
          });
        }
        return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
      }),
    );

    render(<App />);

    await waitFor(() => expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument());
    await user.type(screen.getByLabelText(/employee code/i), 'LWW-014');
    await user.type(screen.getByLabelText(/password/i), 'wrong');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    const submitButton = () => screen.getByRole('button', { name: /try again in|sign in/i });
    await waitFor(() => expect(screen.getByTestId('lockout-countdown')).toHaveTextContent(/try again in 0:0\d/i));
    expect(submitButton()).toBeDisabled();

    await waitFor(
      () => {
        expect(screen.queryByTestId('lockout-countdown')).not.toBeInTheDocument();
      },
      { timeout: 3000 },
    );
    expect(screen.getByRole('button', { name: /sign in/i })).not.toBeDisabled();
  });

  it('shows different wording for RATE_LIMITED (429) than ACCOUNT_LOCKED (423), so which mechanism fired is never ambiguous', async () => {
    const user = userEvent.setup();
    const retryAt = new Date(Date.now() + 60_000).toISOString();
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/auth/me')) {
          return jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'Not authenticated' } });
        }
        if (url.endsWith('/auth/login')) {
          return jsonResponse(423, {
            error: {
              code: 'ACCOUNT_LOCKED',
              message: 'Account temporarily locked after repeated failed logins.',
              details: { lockedUntil: retryAt },
            },
          });
        }
        return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
      }),
    );

    render(<App />);

    await waitFor(() => expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument());
    await user.type(screen.getByLabelText(/employee code/i), 'LWW-006');
    await user.type(screen.getByLabelText(/password/i), 'wrong');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(screen.getByTestId('lockout-countdown')).toHaveTextContent(/account locked after repeated failed/i);
    });
    // Specifically not the 429 wording — the two must read differently.
    expect(screen.queryByTestId('lockout-countdown')).not.toHaveTextContent(/too many attempts from this device/i);
  });

  it('shows the unit grid, opens the detail drawer, and changes status via an allowed transition', async () => {
    const user = userEvent.setup();
    const housekeepingUser = {
      ...currentUser,
      roles: ['HOUSEKEEPING_STAFF'],
      permissions: { 'unit:read': 'ALL', 'unit:update_status': 'ALL' },
    };
    const unit = {
      id: 'unit_1',
      code: '101',
      name: 'Room 101',
      unitTypeId: 'type_1',
      type: 'ROOM',
      capacity: 2,
      floor: '1',
      status: 'CLEANING',
      version: 1,
      notes: null,
      isActive: true,
    };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: housekeepingUser });
      if (url.endsWith('/units')) return jsonResponse(200, { units: [unit] });
      if (url.endsWith('/unit-types')) return jsonResponse(200, { unitTypes: [{ id: 'type_1', name: 'Standard' }] });
      if (url.endsWith('/units/unit_1/timeline')) return jsonResponse(200, { events: [] });
      // Real gap found live-testing, 2026-08-23: bookings were invisible
      // on the Units drawer for exactly this role (HOUSEKEEPING_STAFF —
      // holds unit:read but not booking:read) — this asserts the fix.
      if (url.endsWith('/units/unit_1/bookings')) {
        return jsonResponse(200, {
          bookings: [
            {
              id: 'booking_1',
              referenceNo: 'LWW-260823-0003',
              guestName: 'Jane Dela Cruz',
              type: 'OVERNIGHT',
              status: 'CONFIRMED',
              startAt: '2026-08-25T06:00:00.000Z',
              endAt: '2026-08-26T04:00:00.000Z',
            },
          ],
        });
      }
      if (url.endsWith('/units/unit_1/status')) {
        return jsonResponse(200, { id: 'unit_1', status: 'CLEANED', version: 2 });
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => expect(screen.getByRole('link', { name: 'Units' })).toBeInTheDocument());
    await user.click(screen.getByRole('link', { name: 'Units' }));

    await waitFor(() => expect(screen.getByText('101')).toBeInTheDocument());
    await user.click(screen.getByText('101'));

    await waitFor(() => expect(screen.getByRole('heading', { name: /101 — Room 101/i })).toBeInTheDocument());

    // A HOUSEKEEPING_STAFF user (no booking:read) still sees the
    // reservation — the endpoint is gated on unit:read, not booking:read.
    // Status badge stays CLEANING regardless — bookings never drive it.
    expect(await screen.findByText(/Booked: Jane Dela Cruz/)).toBeInTheDocument();
    expect(screen.getByText(/ref LWW-260823-0003/)).toBeInTheDocument();
    // Status badge is unaffected by the booking — still CLEANING (shown
    // twice: the grid tile behind the drawer, and the drawer's own badge).
    expect(screen.getAllByText('Cleaning').length).toBe(2);

    const markCleanedButton = await screen.findByRole('button', { name: /mark cleaned/i });
    await user.click(markCleanedButton);

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([input]) => String(input).includes('/units/unit_1/status')),
      ).toBe(true);
    });
  });

  it('shows the admin override for SYSTEM_ADMIN on a READY unit and uses it to reach OCCUPIED', async () => {
    // Reproduces the original reported bug (originally found at INSPECTED,
    // since retired 2026-08-22 — see unitStatus.ts): a unit stuck at an
    // automatic-only status with only OUT_OF_ORDER/BLOCKED manual buttons
    // showing, no way to advance even for SYSTEM_ADMIN, until the override
    // button got wired into this drawer. READY -> OCCUPIED is now one of
    // only two remaining automatic-only transitions, so it's the scenario
    // that still exercises this.
    const user = userEvent.setup();
    const adminUser = {
      ...currentUser,
      roles: ['SYSTEM_ADMIN'],
      permissions: { 'unit:read': 'ALL', 'unit:block': 'ALL', 'unit:manage': 'ALL' },
    };
    const unit = {
      id: 'unit_1',
      code: 'R01',
      name: 'Room 1',
      unitTypeId: 'type_1',
      type: 'ROOM',
      capacity: 2,
      floor: null,
      status: 'READY',
      version: 5,
      notes: null,
      isActive: true,
    };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: adminUser });
      if (url.endsWith('/units')) return jsonResponse(200, { units: [unit] });
      if (url.endsWith('/unit-types')) return jsonResponse(200, { unitTypes: [{ id: 'type_1', name: 'Standard' }] });
      if (url.endsWith('/units/unit_1/timeline')) return jsonResponse(200, { events: [] });
      if (url.endsWith('/units/unit_1/status')) {
        return jsonResponse(200, { id: 'unit_1', status: 'OCCUPIED', version: 6 });
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => expect(screen.getByRole('link', { name: 'Units' })).toBeInTheDocument());
    await user.click(screen.getByRole('link', { name: 'Units' }));
    await waitFor(() => expect(screen.getByText('R01')).toBeInTheDocument());
    await user.click(screen.getByText('R01'));

    await waitFor(() => expect(screen.getByRole('heading', { name: /R01 — Room 1/i })).toBeInTheDocument());
    const overrideButton = await screen.findByRole('button', { name: /override.*occupied/i });
    await user.click(overrideButton);

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/units/unit_1/status'))).toBe(true);
    });
  });

  it('lets a caller with unit:force_status jump a unit to any status with an optional note, and shows the badge only when a note was given', async () => {
    const user = userEvent.setup();
    const adminUser = {
      ...currentUser,
      roles: ['SYSTEM_ADMIN'],
      permissions: { 'unit:read': 'ALL', 'unit:force_status': 'ALL', 'unit:manage': 'ALL' },
    };
    const unit = {
      id: 'unit_1',
      code: 'R02',
      name: 'Room 2',
      unitTypeId: 'type_1',
      type: 'ROOM',
      capacity: 2,
      floor: null,
      status: 'VACANT_DIRTY',
      version: 0,
      notes: null,
      isActive: true,
      latestNote: null,
    };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: adminUser });
      if (url.endsWith('/units')) return jsonResponse(200, { units: [unit] });
      if (url.endsWith('/unit-types')) return jsonResponse(200, { unitTypes: [{ id: 'type_1', name: 'Standard' }] });
      if (url.endsWith('/units/unit_1/timeline')) return jsonResponse(200, { events: [] });
      if (url.endsWith('/units/unit_1/force-status')) {
        return jsonResponse(200, { id: 'unit_1', status: 'OCCUPIED', version: 1 });
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => expect(screen.getByRole('link', { name: 'Units' })).toBeInTheDocument());
    await user.click(screen.getByRole('link', { name: 'Units' }));
    await waitFor(() => expect(screen.getByText('R02')).toBeInTheDocument());
    await user.click(screen.getByText('R02'));

    await waitFor(() => expect(screen.getByRole('heading', { name: /R02 — Room 2/i })).toBeInTheDocument());
    const forceButton = await screen.findByRole('button', { name: /force correction/i });

    // Note is optional: submitting with an empty note must still call the API.
    await user.selectOptions(screen.getByLabelText(/correct status to/i), 'OCCUPIED');
    await user.click(forceButton);

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/units/unit_1/force-status'))).toBe(
        true,
      );
    });
    const forceStatusCall = (fetchMock.mock.calls as unknown as [RequestInfo | URL, RequestInit | undefined][]).find(
      ([input]) => String(input).includes('/units/unit_1/force-status'),
    );
    expect(JSON.parse(forceStatusCall?.[1]?.body as string).note).toBeUndefined();

    await user.click(screen.getByText(/close/i));
    // No note was given, so no badge on the tile.
    expect(screen.queryByRole('img', { name: /^note:/i })).not.toBeInTheDocument();
  });

  it('updates the grid tile live when a realtime unit.status.changed broadcast arrives — no refetch, no manual refresh', async () => {
    const housekeepingUser = {
      ...currentUser,
      roles: ['HOUSEKEEPING_STAFF'],
      permissions: { 'unit:read': 'ALL', 'unit:update_status': 'ALL' },
    };
    const unit = {
      id: 'unit_1',
      code: 'R03',
      name: 'Room 3',
      unitTypeId: 'type_1',
      type: 'ROOM',
      capacity: 2,
      floor: null,
      status: 'CLEANING',
      version: 1,
      notes: null,
      isActive: true,
      latestNote: null,
    };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: housekeepingUser });
      if (url.endsWith('/units')) return jsonResponse(200, { units: [unit] });
      if (url.endsWith('/unit-types')) return jsonResponse(200, { unitTypes: [{ id: 'type_1', name: 'Standard' }] });
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => expect(screen.getByRole('link', { name: 'Units' })).toBeInTheDocument());
    await userEvent.setup().click(screen.getByRole('link', { name: 'Units' }));
    await waitFor(() => expect(screen.getByText('Cleaning')).toBeInTheDocument());

    await waitFor(() => expect(capturedRealtimeHandlers).not.toBeNull());

    // Simulate a status change made in a *different* browser (e.g. via
    // the Admin override panel there) — this page never called any
    // status-change endpoint itself, only the realtime subscription
    // fired, exactly as spec §11 requires: "a status change in one
    // browser appears in another within 2s without refresh."
    act(() => {
      capturedRealtimeHandlers?.onEvent({
        entityId: 'unit_1',
        actorId: 'user_2',
        at: new Date().toISOString(),
        summary: 'R03 moved to CLEANED',
        fromStatus: 'CLEANING',
        toStatus: 'CLEANED',
        version: 2,
        note: 'finished early',
      });
    });

    await waitFor(() => expect(screen.getByText('Cleaned')).toBeInTheDocument());
    expect(screen.queryByText('Cleaning')).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: /note: finished early/i })).toBeInTheDocument();

    // A stale/out-of-order broadcast (lower version than what's already
    // applied) must not regress the tile.
    act(() => {
      capturedRealtimeHandlers?.onEvent({
        entityId: 'unit_1',
        actorId: 'user_2',
        at: new Date().toISOString(),
        summary: 'stale replay',
        fromStatus: 'VACANT_DIRTY',
        toStatus: 'CLEANING',
        version: 1,
        note: null,
      });
    });
    expect(screen.getByText('Cleaned')).toBeInTheDocument();
  });

  it('refreshes the open drawer\'s Timeline list live when a realtime broadcast changes this unit — real bug, reported live 2026-08-23', async () => {
    const housekeepingUser = {
      ...currentUser,
      roles: ['HOUSEKEEPING_STAFF'],
      permissions: { 'unit:read': 'ALL', 'unit:update_status': 'ALL' },
    };
    const unit = {
      id: 'unit_1',
      code: 'R04',
      name: 'Room 4',
      unitTypeId: 'type_1',
      type: 'ROOM',
      capacity: 2,
      floor: null,
      status: 'CLEANING',
      version: 1,
      notes: null,
      isActive: true,
      latestNote: null,
    };
    let timelineCallCount = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: housekeepingUser });
      if (url.endsWith('/units')) return jsonResponse(200, { units: [unit] });
      if (url.endsWith('/unit-types')) return jsonResponse(200, { unitTypes: [{ id: 'type_1', name: 'Standard' }] });
      if (url.endsWith('/units/unit_1/timeline')) {
        timelineCallCount += 1;
        if (timelineCallCount === 1) {
          return jsonResponse(200, { events: [] });
        }
        return jsonResponse(200, {
          events: [
            {
              id: 'event_new',
              fromStatus: 'CLEANING',
              toStatus: 'CLEANED',
              note: null,
              createdAt: new Date().toISOString(),
              actor: { id: 'user_2', fullName: 'Someone Else', employeeCode: 'LWW-099' },
            },
          ],
        });
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => expect(screen.getByRole('link', { name: 'Units' })).toBeInTheDocument());
    await userEvent.setup().click(screen.getByRole('link', { name: 'Units' }));
    await waitFor(() => expect(screen.getByText('R04')).toBeInTheDocument());
    await userEvent.setup().click(screen.getByText('R04'));

    await waitFor(() => expect(screen.getByText('No status changes recorded yet.')).toBeInTheDocument());
    expect(timelineCallCount).toBe(1);

    await waitFor(() => expect(capturedRealtimeHandlers).not.toBeNull());

    // A status change on this exact unit, broadcast from elsewhere,
    // while its drawer is open here. UnitsPage patches its own `units`
    // state directly from this event (not a refetch of GET /units), so
    // the drawer's timeline refetch is the thing actually being tested.
    act(() => {
      capturedRealtimeHandlers?.onEvent({
        entityId: 'unit_1',
        actorId: 'user_2',
        at: new Date().toISOString(),
        summary: 'R04 moved to CLEANED',
        fromStatus: 'CLEANING',
        toStatus: 'CLEANED',
        version: 2,
        note: null,
      });
    });

    await waitFor(() => expect(timelineCallCount).toBe(2));
    await waitFor(() => expect(screen.queryByText('No status changes recorded yet.')).not.toBeInTheDocument());
    expect(screen.getByText('Someone Else', { exact: false })).toBeInTheDocument();
  });

  it('renders the Command Center: real KPI counts, a dirty-room alert, and the activity feed', async () => {
    const managerUser = {
      ...currentUser,
      roles: ['RESORT_MANAGER'],
      permissions: { 'unit:read': 'ALL' },
    };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: managerUser });
      if (url.includes('/units/dashboard')) {
        return jsonResponse(200, {
          kpi: {
            occupied: 3,
            ready: 2,
            dirty: 1,
            outOfOrder: 1,
            urgentOpenWorkOrders: 2,
            checkinsToday: 5,
            checkoutsToday: 4,
            openFnbOrders: 6,
          },
          dirtyRooms: [{ id: 'unit_9', code: 'R09', name: 'Room 9', dirtyMinutes: 200 }],
          slaBreachedWorkOrders: [
            { id: 'wo_1', referenceNo: 'LWW-WO-0007', title: 'Leaking faucet', unitCode: 'R03', overdueMinutes: 90 },
          ],
          overdueAmenityRequests: [
            { id: 'am_1', referenceNo: 'LWW-AM-0004', itemName: 'Beach towel', unitCode: 'R03', overdueMinutes: 45 },
          ],
        });
      }
      if (url.includes('/units/activity')) {
        return jsonResponse(200, {
          events: [
            {
              id: 'event_1',
              unitCode: 'R05',
              unitName: 'Room 5',
              fromStatus: 'CLEANING',
              toStatus: 'CLEANED',
              note: null,
              actorName: 'Room Attendant 1 (Demo)',
              createdAt: '2026-08-23T09:00:00Z',
            },
          ],
        });
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Command Center' })).toBeInTheDocument());

    // Real KPI counts, computed from actual unit/work-order data. Values
    // are read from within each labelled card, not by bare digit text —
    // several cards can share the same value (e.g. Ready and Out of order
    // both being small integers) so a bare `getByText('2')` is ambiguous.
    await waitFor(() => expect(screen.getByText('3')).toBeInTheDocument());
    expect(screen.getByText('Occupied')).toBeInTheDocument();
    expect(screen.getByText('Open urgent work orders').parentElement).toHaveTextContent('2');
    expect(screen.getByText('Check-ins today').parentElement).toHaveTextContent('5');
    expect(screen.getByText('Check-outs today').parentElement).toHaveTextContent('4');
    expect(screen.getByText('Open F&B tickets').parentElement).toHaveTextContent('6');
    expect(screen.queryByText('Arrivals / departures today')).not.toBeInTheDocument();
    expect(screen.queryByText('Pending payment verifications')).not.toBeInTheDocument();

    // Attention queue: three real items (a room dirty past 3h, a work
    // order past its SLA due date, an overdue amenity request). Unverified
    // payments >24h was removed outright — payment tracking is permanently
    // out of scope, not a later milestone.
    expect(screen.getByText(/R09 — Room 9 still dirty/i)).toBeInTheDocument();
    expect(screen.getByText(/LWW-WO-0007 — Leaking faucet \(R03\) past due/i)).toBeInTheDocument();
    expect(screen.getByText('1h 30m')).toBeInTheDocument();
    expect(screen.getByText(/LWW-AM-0004 — Beach towel \(R03\) overdue/i)).toBeInTheDocument();
    expect(screen.getByText('45m')).toBeInTheDocument();
    expect(screen.queryByText('Unverified payments >24h')).not.toBeInTheDocument();

    // Live activity feed, backfilled from GET /units/activity.
    await waitFor(() => expect(screen.getByText(/R05 — Room 5: Cleaning → Cleaned/i)).toBeInTheDocument());
    expect(screen.getByText(/Room Attendant 1 \(Demo\)/i)).toBeInTheDocument();

    // Open urgent work orders is always a real link (workorder:read is
    // the one permission every role holds). Open F&B tickets must NOT be
    // one here — this managerUser fixture holds only unit:read, no
    // fnb:read, so linking to a page that would immediately refuse them
    // (RequirePermission) is exactly the dead-end this card is built to
    // avoid offering.
    const urgentLink = screen.getByRole('link', { name: /Open urgent work orders/ });
    expect(urgentLink).toHaveAttribute('href', '/work-orders');
    expect(screen.queryByRole('link', { name: /Open F&B tickets/ })).not.toBeInTheDocument();
  });

  // Client-directed feature, 2026-08-31: the first Command Center data
  // that isn't universally visible to every unit:read holder (see
  // getUnitsDashboard's own doc comment). This is the frontend half of
  // that gate — a viewer without remittance:read/quotation:read must see
  // neither card nor either queue row type, even if the mocked backend
  // response were to (hypothetically) include the fields, since the real
  // backend never actually would. Testing the frontend gate itself, not
  // just that the backend omitted the data, so a future refactor on
  // either side can't reintroduce a leak without this catching it.
  it('a viewer without remittance:read/quotation:read sees neither KPI card nor queue rows, even if the payload includes the data', async () => {
    const housekeepingUser = {
      ...currentUser,
      roles: ['POC_HOUSEKEEPING'],
      permissions: { 'unit:read': 'ALL' },
    };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: housekeepingUser });
      if (url.includes('/units/dashboard')) {
        return jsonResponse(200, {
          kpi: {
            occupied: 0,
            ready: 0,
            dirty: 0,
            outOfOrder: 0,
            urgentOpenWorkOrders: 0,
            checkinsToday: 0,
            checkoutsToday: 0,
            openFnbOrders: 0,
            // A real backend response would never include these two keys
            // for this permission set — present here anyway, to prove
            // the frontend's own gate (not just the backend's omission)
            // is what keeps them off screen.
            pendingRemittances: 3,
            pendingQuotations: 2,
          },
          dirtyRooms: [],
          slaBreachedWorkOrders: [],
          overdueAmenityRequests: [],
          remittanceRequests: [{ id: 'remit_1', referenceNo: 'RM-260831-0001', name: 'Juan Dela Cruz', waitingMinutes: 30 }],
          quotationRequests: [{ id: 'quote_1', referenceNo: 'QT-260831-0001', name: 'Maria Santos', waitingMinutes: 20 }],
        });
      }
      if (url.includes('/units/activity')) return jsonResponse(200, { events: [] });
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Command Center' })).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('Occupied')).toBeInTheDocument());

    expect(screen.queryByText('Pending payment verifications')).not.toBeInTheDocument();
    expect(screen.queryByText('Pending quotations')).not.toBeInTheDocument();
    expect(screen.queryByText(/RM-260831-0001/)).not.toBeInTheDocument();
    expect(screen.queryByText(/QT-260831-0001/)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /payment verification/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /quotation/i })).not.toBeInTheDocument();
  });

  // A viewer with both permissions sees both cards with the real counts
  // and both queue row types, and each — card and row alike — is a real
  // link to its own page.
  it('a viewer with remittance:read and quotation:read sees both KPI cards and queue rows, each navigating to its own page', async () => {
    const user = userEvent.setup();
    const adminStaffUser = {
      ...currentUser,
      roles: ['ADMIN_STAFF'],
      permissions: { 'unit:read': 'ALL', 'remittance:read': 'ALL', 'quotation:read': 'ALL' },
    };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: adminStaffUser });
      if (url.includes('/units/dashboard')) {
        return jsonResponse(200, {
          kpi: {
            occupied: 0,
            ready: 0,
            dirty: 0,
            outOfOrder: 0,
            urgentOpenWorkOrders: 0,
            checkinsToday: 0,
            checkoutsToday: 0,
            openFnbOrders: 0,
            pendingRemittances: 1,
            pendingQuotations: 1,
          },
          dirtyRooms: [],
          slaBreachedWorkOrders: [],
          overdueAmenityRequests: [],
          remittanceRequests: [{ id: 'remit_1', referenceNo: 'RM-260831-0001', name: 'Juan Dela Cruz', waitingMinutes: 30 }],
          quotationRequests: [{ id: 'quote_1', referenceNo: 'QT-260831-0001', name: 'Maria Santos', waitingMinutes: 20 }],
        });
      }
      if (url.includes('/units/activity')) return jsonResponse(200, { events: [] });
      if (url.endsWith('/remittance-requests')) return jsonResponse(200, { remittanceRequests: [] });
      if (url.endsWith('/quotation-requests')) return jsonResponse(200, { quotationRequests: [] });
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Command Center' })).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('Pending payment verifications')).toBeInTheDocument());
    expect(screen.getByText('Pending payment verifications').parentElement).toHaveTextContent('1');
    expect(screen.getByText('Pending quotations').parentElement).toHaveTextContent('1');
    expect(screen.getByText(/RM-260831-0001 — Juan Dela Cruz awaiting verification/i)).toBeInTheDocument();
    expect(screen.getByText(/QT-260831-0001 — Maria Santos awaiting quotation/i)).toBeInTheDocument();

    const kpiLink = screen.getByRole('link', { name: /Pending payment verifications/ });
    expect(kpiLink).toHaveAttribute('href', '/payment-verification');
    const rowLink = screen.getByRole('link', { name: /RM-260831-0001 — Juan Dela Cruz awaiting verification/i });
    expect(rowLink).toHaveAttribute('href', '/payment-verification');

    await user.click(screen.getByRole('link', { name: /Pending quotations/ }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Quotations' })).toBeInTheDocument());
  });

  // Real feature, this slice: clicking either hero KPI card navigates.
  // Open F&B tickets only links when the viewer holds fnb:read — this
  // fixture grants it (mirroring the real fix landing alongside this
  // feature: OWNER now holds fnb:read) so both cards are exercised as
  // actual navigation, not just asserted present.
  it('Open urgent work orders and Open F&B tickets KPI cards navigate to their pages', async () => {
    const user = userEvent.setup();
    const managerUser = {
      ...currentUser,
      roles: ['RESORT_MANAGER'],
      permissions: { 'unit:read': 'ALL', 'workorder:read': 'ALL', 'fnb:read': 'ALL' },
    };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: managerUser });
      if (url.includes('/units/dashboard')) {
        return jsonResponse(200, {
          kpi: { occupied: 0, ready: 0, dirty: 0, outOfOrder: 0, urgentOpenWorkOrders: 1, checkinsToday: 0, checkoutsToday: 0, openFnbOrders: 1 },
          dirtyRooms: [],
          slaBreachedWorkOrders: [],
          overdueAmenityRequests: [],
        });
      }
      if (url.includes('/units/activity')) return jsonResponse(200, { events: [] });
      if (url.endsWith('/work-orders')) return jsonResponse(200, { workOrders: [] });
      if (url.endsWith('/work-orders?mine=true')) return jsonResponse(200, { workOrders: [] });
      if (url.endsWith('/work-orders/assignable-users')) return jsonResponse(200, { users: [] });
      if (url.endsWith('/units')) return jsonResponse(200, { units: [] });
      if (url.endsWith('/menu-items')) return jsonResponse(200, { menuItems: [] });
      if (url.includes('/fnb-orders')) return jsonResponse(200, { fnbOrders: [] });
      if (url.includes('/units/orderable')) return jsonResponse(200, { units: [] });
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Command Center' })).toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('link', { name: /Open urgent work orders/ })).toBeInTheDocument());

    await user.click(screen.getByRole('link', { name: /Open urgent work orders/ }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'My Tasks' })).toBeInTheDocument());

    // Back to the dashboard, then the F&B card.
    await user.click(screen.getByRole('link', { name: 'Command Center' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Command Center' })).toBeInTheDocument());

    await user.click(screen.getByRole('link', { name: /Open F&B tickets/ }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Restaurant' })).toBeInTheDocument());
  });

  // Spec §3 / §11 M6: "cache the last-known board read-only so a staff
  // member with no signal still sees their task list." Seeds the
  // localStorage snapshot directly (the same shape DashboardPage itself
  // writes via lib/dashboardCache.ts after a real successful load) rather
  // than depending on a prior render's side effect, then drives a load
  // where both /units/dashboard and /units/activity fail outright — the
  // literal shape of "the network dropped mid-session."
  it('Command Center falls back to the cached last-known board when the live fetch fails, with a visible offline banner', async () => {
    const managerUser = {
      ...currentUser,
      roles: ['RESORT_MANAGER'],
      permissions: { 'unit:read': 'ALL' },
    };

    window.localStorage.setItem(
      'lwwbr.dashboardSnapshot.v1',
      JSON.stringify({
        dashboard: {
          kpi: {
            occupied: 7,
            ready: 1,
            dirty: 0,
            outOfOrder: 0,
            urgentOpenWorkOrders: 0,
            checkinsToday: 0,
            checkoutsToday: 0,
            openFnbOrders: 0,
          },
          dirtyRooms: [],
          slaBreachedWorkOrders: [],
          overdueAmenityRequests: [],
        },
        feed: [
          {
            id: 'cached_event_1',
            line: 'R11 — Room 11: Ready → Occupied',
            actorName: 'Front Desk (Demo)',
            note: null,
            at: '2026-08-30T10:00:00Z',
          },
        ],
        cachedAt: '2026-08-30T10:05:00Z',
      }),
    );

    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: managerUser });
      if (url.includes('/units/dashboard') || url.includes('/units/activity')) {
        return Promise.reject(new Error('network request failed'));
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Command Center' })).toBeInTheDocument());

    // The cached KPI count renders, not a generic error state.
    await waitFor(() => expect(screen.getByText('7')).toBeInTheDocument());
    expect(screen.getByText('Occupied')).toBeInTheDocument();
    expect(screen.getByText(/R11 — Room 11: Ready → Occupied/i)).toBeInTheDocument();

    // The offline banner is visible and names the cached timestamp — this
    // is what makes the view read-only-and-stale legible, not silently
    // wrong.
    const banner = screen.getByRole('status');
    expect(banner).toHaveTextContent('Offline');
    expect(banner).toHaveTextContent(new Date('2026-08-30T10:05:00Z').toLocaleString());
  });

  // Redesign, 2026-08-24 (client decision, live-testing feedback): "this
  // app's job is monitoring the resort's current, live state, not
  // managing reservations... every guest already has a real booking ID."
  // The old Bookings page is gone; check-in is now a quick-action panel
  // below the Units grid, and check-out is a checklist in the Unit
  // drawer. Both gated on booking:checkin/booking:checkout the same way
  // the work order Verify button is hidden from a cross-department POC.
  describe('Check-in panel and checklist check-out on the Units page', () => {
    const readyUnit = {
      id: 'unit_1',
      code: 'R01',
      name: 'Room 1',
      unitTypeId: 'type_1',
      type: 'ROOM',
      capacity: 2,
      floor: null,
      status: 'READY',
      version: 3,
      notes: null,
      isActive: true,
    };
    const occupiedBooking = {
      id: 'booking_1',
      referenceNo: 'EXT-100',
      guestName: 'Arrival Guest',
      type: 'OVERNIGHT',
      status: 'CHECKED_IN',
      startAt: '2026-08-24T06:00:00.000Z',
      endAt: null,
    };

    it('hides both the Check-in panel and the drawer Check-out button for a role without either permission', async () => {
      const housekeepingUser = {
        ...currentUser,
        roles: ['HOUSEKEEPING_STAFF'],
        permissions: { 'unit:read': 'ALL', 'unit:update_status': 'ALL' },
      };
      const occupiedUnit = { ...readyUnit, status: 'OCCUPIED' };
      const fetchMock = vi.fn((input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/auth/me')) return jsonResponse(200, { user: housekeepingUser });
        if (url.endsWith('/units')) return jsonResponse(200, { units: [occupiedUnit] });
        if (url.endsWith('/unit-types')) return jsonResponse(200, { unitTypes: [{ id: 'type_1', name: 'Standard' }] });
        if (url.endsWith('/units/unit_1/timeline')) return jsonResponse(200, { events: [] });
        if (url.endsWith('/units/unit_1/bookings')) return jsonResponse(200, { bookings: [occupiedBooking] });
        return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
      });
      vi.stubGlobal('fetch', fetchMock);

      render(<App />);

      await waitFor(() => expect(screen.getByRole('link', { name: 'Units' })).toBeInTheDocument());
      await userEvent.setup().click(screen.getByRole('link', { name: 'Units' }));
      await waitFor(() => expect(screen.getByText('R01')).toBeInTheDocument());

      expect(screen.queryByText('Check-in')).not.toBeInTheDocument();

      await userEvent.setup().click(screen.getByText('R01'));
      expect(await screen.findByText(/Booked: Arrival Guest/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Check out' })).not.toBeInTheDocument();
    });

    // Real bug found live-testing, 2026-08-24: the room checklist
    // disabled BLOCKED/OUT_OF_ORDER but left an already-Occupied room
    // fully clickable — selecting it risked double-booking a room that
    // already has a guest in it.
    it('disables an already-Occupied room in the check-in checklist, same as Blocked/Out of order', async () => {
      const user = userEvent.setup();
      const adminStaffUser = {
        ...currentUser,
        roles: ['ADMIN_STAFF'],
        permissions: { 'unit:read': 'ALL', 'booking:checkin': 'ALL' },
      };
      const units = [
        readyUnit,
        { ...readyUnit, id: 'unit_2', code: 'R02', status: 'OCCUPIED' },
        { ...readyUnit, id: 'unit_3', code: 'R03', status: 'BLOCKED' },
      ];
      const fetchMock = vi.fn((input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/auth/me')) return jsonResponse(200, { user: adminStaffUser });
        if (url.endsWith('/units')) return jsonResponse(200, { units });
        if (url.endsWith('/unit-types')) return jsonResponse(200, { unitTypes: [{ id: 'type_1', name: 'Standard' }] });
        return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
      });
      vi.stubGlobal('fetch', fetchMock);

      render(<App />);

      await waitFor(() => expect(screen.getByRole('link', { name: 'Units' })).toBeInTheDocument());
      await user.click(screen.getByRole('link', { name: 'Units' }));
      await waitFor(() => expect(screen.getByText('Check-in')).toBeInTheDocument());
      await user.click(screen.getByText('Rooms'));

      expect(screen.getByLabelText('R01 — Room 1')).not.toBeDisabled();
      expect(screen.getByLabelText('R02 — Room 1')).toBeDisabled();
      expect(screen.getByLabelText('R03 — Room 1')).toBeDisabled();
    });

    it('checks in a guest directly from the Check-in panel below the grid', async () => {
      const user = userEvent.setup();
      const adminStaffUser = {
        ...currentUser,
        roles: ['ADMIN_STAFF'],
        permissions: { 'unit:read': 'ALL', 'booking:checkin': 'ALL', 'booking:checkout': 'ALL' },
      };
      let checkinBody: unknown = null;
      let unitsCallCount = 0;
      const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/auth/me')) return jsonResponse(200, { user: adminStaffUser });
        if (url.endsWith('/units')) {
          unitsCallCount += 1;
          return jsonResponse(200, { units: [readyUnit] });
        }
        if (url.endsWith('/unit-types')) return jsonResponse(200, { unitTypes: [{ id: 'type_1', name: 'Standard' }] });
        if (url.endsWith('/bookings/checkin') && init?.method === 'POST') {
          checkinBody = JSON.parse(init.body as string);
          return jsonResponse(201, { booking: { id: 'booking_1', referenceNo: 'EXT-100', status: 'CHECKED_IN' } });
        }
        return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
      });
      vi.stubGlobal('fetch', fetchMock);

      render(<App />);

      await waitFor(() => expect(screen.getByRole('link', { name: 'Units' })).toBeInTheDocument());
      await user.click(screen.getByRole('link', { name: 'Units' }));
      await waitFor(() => expect(screen.getByText('Check-in')).toBeInTheDocument());

      await user.type(screen.getByLabelText('Guest name'), 'Arrival Guest');
      await user.type(screen.getByLabelText('Booking ID'), 'EXT-100');
      await user.click(screen.getByLabelText('R01 — Room 1'));
      const callsBeforeSubmit = unitsCallCount;
      await user.click(screen.getByRole('button', { name: 'Check in' }));

      expect(await screen.findByText(/Arrival Guest checked in/)).toBeInTheDocument();
      expect(checkinBody).toEqual(
        expect.objectContaining({
          guestName: 'Arrival Guest',
          externalBookingId: 'EXT-100',
          units: [{ unitId: 'unit_1' }],
          acknowledgeNotReady: false,
        }),
      );
      // Grid refetches after a successful check-in.
      await waitFor(() => expect(unitsCallCount).toBeGreaterThan(callsBeforeSubmit));
    });

    it('warns rather than hard-blocking check-in from a not-yet-Ready room, then checks in on acknowledge', async () => {
      const user = userEvent.setup();
      const dirtyUnit = { ...readyUnit, status: 'VACANT_DIRTY' };
      const adminStaffUser = {
        ...currentUser,
        roles: ['ADMIN_STAFF'],
        permissions: { 'unit:read': 'ALL', 'booking:checkin': 'ALL' },
      };
      const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/auth/me')) return jsonResponse(200, { user: adminStaffUser });
        if (url.endsWith('/units')) return jsonResponse(200, { units: [dirtyUnit] });
        if (url.endsWith('/unit-types')) return jsonResponse(200, { unitTypes: [{ id: 'type_1', name: 'Standard' }] });
        if (url.endsWith('/bookings/checkin') && init?.method === 'POST') {
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
          return jsonResponse(201, { booking: { id: 'booking_1', referenceNo: 'EXT-100', status: 'CHECKED_IN' } });
        }
        return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
      });
      vi.stubGlobal('fetch', fetchMock);

      render(<App />);

      await waitFor(() => expect(screen.getByRole('link', { name: 'Units' })).toBeInTheDocument());
      await user.click(screen.getByRole('link', { name: 'Units' }));
      await waitFor(() => expect(screen.getByText('Check-in')).toBeInTheDocument());

      await user.type(screen.getByLabelText('Guest name'), 'Arrival Guest');
      await user.type(screen.getByLabelText('Booking ID'), 'EXT-100');
      await user.click(screen.getByLabelText('R01 — Room 1'));
      await user.click(screen.getByRole('button', { name: 'Check in' }));

      expect(await screen.findByText(/R01 is not Ready yet/)).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Check in anyway' }));

      expect(await screen.findByText(/Arrival Guest checked in/)).toBeInTheDocument();
    });

    it('checks out a single-room booking directly, pre-confirmed with no prompt needed', async () => {
      const user = userEvent.setup();
      const occupiedUnit = { ...readyUnit, status: 'OCCUPIED' };
      const adminStaffUser = {
        ...currentUser,
        roles: ['ADMIN_STAFF'],
        permissions: { 'unit:read': 'ALL', 'booking:checkout': 'ALL' },
      };
      let checkoutBody: unknown = null;
      const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/auth/me')) return jsonResponse(200, { user: adminStaffUser });
        if (url.endsWith('/units')) return jsonResponse(200, { units: [occupiedUnit] });
        if (url.endsWith('/unit-types')) return jsonResponse(200, { unitTypes: [{ id: 'type_1', name: 'Standard' }] });
        if (url.endsWith('/units/unit_1/timeline')) return jsonResponse(200, { events: [] });
        if (url.endsWith('/units/unit_1/bookings')) return jsonResponse(200, { bookings: [occupiedBooking] });
        if (url.includes('/bookings/group?referenceNo=')) {
          return jsonResponse(200, {
            units: [{ unitId: 'unit_1', code: 'R01', name: 'Room 1', bookingId: 'booking_1', guestName: 'Arrival Guest' }],
          });
        }
        if (url.endsWith('/bookings/checkout') && init?.method === 'POST') {
          checkoutBody = JSON.parse(init.body as string);
          return jsonResponse(200, { checkedOutUnitIds: ['unit_1'], finalizedBookingIds: ['booking_1'] });
        }
        return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
      });
      vi.stubGlobal('fetch', fetchMock);

      render(<App />);

      await waitFor(() => expect(screen.getByRole('link', { name: 'Units' })).toBeInTheDocument());
      await user.click(screen.getByRole('link', { name: 'Units' }));
      await waitFor(() => expect(screen.getByText('R01')).toBeInTheDocument());
      await user.click(screen.getByText('R01'));

      await user.click(await screen.findByRole('button', { name: 'Check out' }));
      expect(await screen.findByText('Confirm check-out:')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /Check out 1 room/ }));

      await waitFor(() => expect(checkoutBody).toEqual({ unitIds: ['unit_1'] }));
    });

    // Real gap found live-testing, 2026-08-24: a booking created and
    // checked in through the old, now-removed "New booking" flow may
    // never have completed its own transition to CHECKED_IN before that
    // flow was deleted, leaving it stuck at a legacy PENDING status
    // forever. The Check-out button must still show — it's keyed off the
    // room's own live status (Occupied), not the booking's bookkeeping
    // status.
    it('shows the Check-out button for a room that is Occupied even when its booking is stuck at a legacy PENDING status', async () => {
      const user = userEvent.setup();
      const occupiedUnit = { ...readyUnit, status: 'OCCUPIED' };
      const legacyBooking = { ...occupiedBooking, status: 'PENDING' };
      const adminHeadUser = {
        ...currentUser,
        roles: ['ADMIN_HEAD'],
        permissions: { 'unit:read': 'ALL', 'booking:checkout': 'ALL' },
      };
      const fetchMock = vi.fn((input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/auth/me')) return jsonResponse(200, { user: adminHeadUser });
        if (url.endsWith('/units')) return jsonResponse(200, { units: [occupiedUnit] });
        if (url.endsWith('/unit-types')) return jsonResponse(200, { unitTypes: [{ id: 'type_1', name: 'Standard' }] });
        if (url.endsWith('/units/unit_1/timeline')) return jsonResponse(200, { events: [] });
        if (url.endsWith('/units/unit_1/bookings')) return jsonResponse(200, { bookings: [legacyBooking] });
        return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
      });
      vi.stubGlobal('fetch', fetchMock);

      render(<App />);

      await waitFor(() => expect(screen.getByRole('link', { name: 'Units' })).toBeInTheDocument());
      await user.click(screen.getByRole('link', { name: 'Units' }));
      await waitFor(() => expect(screen.getByText('R01')).toBeInTheDocument());
      await user.click(screen.getByText('R01'));

      expect(await screen.findByText(/Booked: Arrival Guest/)).toBeInTheDocument();
      expect(await screen.findByRole('button', { name: 'Check out' })).toBeInTheDocument();
    });

    it('shows a checklist for a multi-room booking, pre-checking the room opened from, and lets the front desk add another room before confirming', async () => {
      const user = userEvent.setup();
      const occupiedUnit = { ...readyUnit, status: 'OCCUPIED' };
      const adminStaffUser = {
        ...currentUser,
        roles: ['ADMIN_STAFF'],
        permissions: { 'unit:read': 'ALL', 'booking:checkout': 'ALL' },
      };
      let checkoutBody: unknown = null;
      const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/auth/me')) return jsonResponse(200, { user: adminStaffUser });
        if (url.endsWith('/units')) return jsonResponse(200, { units: [occupiedUnit] });
        if (url.endsWith('/unit-types')) return jsonResponse(200, { unitTypes: [{ id: 'type_1', name: 'Standard' }] });
        if (url.endsWith('/units/unit_1/timeline')) return jsonResponse(200, { events: [] });
        if (url.endsWith('/units/unit_1/bookings')) return jsonResponse(200, { bookings: [occupiedBooking] });
        if (url.includes('/bookings/group?referenceNo=')) {
          return jsonResponse(200, {
            units: [
              { unitId: 'unit_1', code: 'R01', name: 'Room 1', bookingId: 'booking_1', guestName: 'Arrival Guest' },
              { unitId: 'unit_2', code: 'R02', name: 'Room 2', bookingId: 'booking_2', guestName: 'Arrival Guest' },
            ],
          });
        }
        if (url.endsWith('/bookings/checkout') && init?.method === 'POST') {
          checkoutBody = JSON.parse(init.body as string);
          return jsonResponse(200, { checkedOutUnitIds: ['unit_1', 'unit_2'], finalizedBookingIds: ['booking_1', 'booking_2'] });
        }
        return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
      });
      vi.stubGlobal('fetch', fetchMock);

      render(<App />);

      await waitFor(() => expect(screen.getByRole('link', { name: 'Units' })).toBeInTheDocument());
      await user.click(screen.getByRole('link', { name: 'Units' }));
      await waitFor(() => expect(screen.getByText('R01')).toBeInTheDocument());
      await user.click(screen.getByText('R01'));

      await user.click(await screen.findByRole('button', { name: 'Check out' }));

      expect(await screen.findByText(/2 rooms are on Booking ID EXT-100/)).toBeInTheDocument();
      const room1Checkbox = screen.getByLabelText(/R01 — Room 1/) as HTMLInputElement;
      const room2Checkbox = screen.getByLabelText(/R02 — Room 2/) as HTMLInputElement;
      // Pre-checked: the room this drawer was opened from.
      expect(room1Checkbox.checked).toBe(true);
      expect(room2Checkbox.checked).toBe(false);

      await user.click(room2Checkbox);
      await user.click(screen.getByRole('button', { name: /Check out 2 rooms/ }));

      await waitFor(() => expect(checkoutBody).toEqual({ unitIds: ['unit_1', 'unit_2'] }));
    });
  });
});
