import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.js';

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

    await waitFor(() => expect(screen.getByText(/Welcome,/i)).toBeInTheDocument());
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
});
