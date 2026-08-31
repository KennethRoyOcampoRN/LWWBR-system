import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.js';

vi.mock('../src/lib/realtime.js', () => ({
  subscribeToUnitStatusChanges: (
    _onEvent: unknown,
    onStatusChange: (status: 'connecting' | 'connected' | 'reconnecting' | 'disabled') => void,
  ) => {
    onStatusChange('connected');
    return () => {};
  },
  subscribeToNotifications: () => () => {},
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
  permissions: { 'unit:read': 'ALL' },
};

describe('AppShell nav', () => {
  beforeEach(() => {
    window.history.pushState({}, '', '/');
  });

  function stubAuthedFetch() {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: currentUser });
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
          },
          dirtyRooms: [],
          slaBreachedWorkOrders: [],
          overdueAmenityRequests: [],
        });
      }
      if (url.includes('/units/activity')) return jsonResponse(200, { events: [] });
      if (url.endsWith('/notifications')) return jsonResponse(200, { notifications: [] });
      if (url.endsWith('/auth/logout') && (input as RequestInit | undefined) !== undefined) {
        return jsonResponse(204, undefined);
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  // Real bug found live-testing, 2026-08-31 (mobile pass): the mobile
  // nav used to render every item as one wrapping horizontal row (long
  // labels like "Command Center" broke onto two lines), and "Sign out"
  // was `hidden md:flex` with no mobile equivalent at all — unreachable
  // on a real phone viewport. This drives the hamburger toggle directly
  // rather than relying on CSS media queries (which jsdom doesn't
  // evaluate) — it's the React state/aria behavior under test, not the
  // Tailwind breakpoint itself.
  it('the hamburger toggle flips aria-expanded and its own accessible name', async () => {
    const user = userEvent.setup();
    stubAuthedFetch();
    render(<App />);

    const toggle = await screen.findByRole('button', { name: 'Open menu' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await user.click(toggle);
    const closeToggle = screen.getByRole('button', { name: 'Close menu' });
    expect(closeToggle).toHaveAttribute('aria-expanded', 'true');

    await user.click(closeToggle);
    expect(screen.getByRole('button', { name: 'Open menu' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('clicking a nav link closes the mobile menu', async () => {
    const user = userEvent.setup();
    stubAuthedFetch();
    render(<App />);

    const toggle = await screen.findByRole('button', { name: 'Open menu' });
    await user.click(toggle);
    expect(screen.getByRole('button', { name: 'Close menu' })).toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: 'Command Center' }));
    expect(screen.getByRole('button', { name: 'Open menu' })).toBeInTheDocument();
  });

  // The concrete second bug this slice fixes: Sign out is now reachable
  // from the same nav list the mobile menu opens, not desktop-only.
  it('Sign out is present in the nav and signs the user out', async () => {
    const user = userEvent.setup();
    const fetchMock = stubAuthedFetch();
    render(<App />);

    await screen.findByRole('button', { name: 'Open menu' });
    const signOutButton = screen.getByRole('button', { name: 'Sign out' });
    expect(signOutButton).toBeInTheDocument();

    await user.click(signOutButton);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/auth/logout'), expect.anything()),
    );
  });
});
