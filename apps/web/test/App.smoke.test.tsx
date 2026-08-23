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
    const markCleanedButton = await screen.findByRole('button', { name: /mark cleaned/i });
    await user.click(markCleanedButton);

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([input]) => String(input).includes('/units/unit_1/status')),
      ).toBe(true);
    });
  });

  it('shows the admin override for SYSTEM_ADMIN on an INSPECTED unit and uses it to reach READY', async () => {
    // Reproduces the exact reported bug: a unit stuck at INSPECTED with
    // only OUT_OF_ORDER/BLOCKED manual buttons showing, no way to the
    // automatic-only READY transition even for SYSTEM_ADMIN. The override
    // button was built server-side but never wired into this drawer.
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
      status: 'INSPECTED',
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
        return jsonResponse(200, { id: 'unit_1', status: 'READY', version: 6 });
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
    const overrideButton = await screen.findByRole('button', { name: /override.*ready/i });
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

  it('renders the Command Center: real KPI counts, an explicitly-stubbed KPI/attention item, a dirty-room alert, and the activity feed', async () => {
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
          kpi: { occupied: 3, ready: 2, dirty: 1, outOfOrder: 1 },
          dirtyRooms: [{ id: 'unit_9', code: 'R09', name: 'Room 9', dirtyMinutes: 200 }],
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

    // Real KPI counts, computed from actual unit data.
    await waitFor(() => expect(screen.getByText('3')).toBeInTheDocument());
    expect(screen.getByText('Occupied')).toBeInTheDocument();

    // Stubbed KPI cards are explicitly labelled, not shown as a bare "0".
    expect(screen.getByText('Open urgent work orders')).toBeInTheDocument();
    expect(screen.getAllByText('Coming in M3').length).toBeGreaterThan(0);

    // Attention queue: the one real item (a room dirty past 3h) plus the
    // three stubbed items for later milestones.
    expect(screen.getByText(/R09 — Room 9 still dirty/i)).toBeInTheDocument();
    expect(screen.getByText('SLA-breached work orders')).toBeInTheDocument();

    // Live activity feed, backfilled from GET /units/activity.
    await waitFor(() => expect(screen.getByText(/R05 — Room 5: Cleaning → Cleaned/i)).toBeInTheDocument());
    expect(screen.getByText(/Room Attendant 1 \(Demo\)/i)).toBeInTheDocument();
  });
});
