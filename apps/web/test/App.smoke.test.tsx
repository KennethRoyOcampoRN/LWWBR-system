import { render, screen, waitFor } from '@testing-library/react';
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

describe('App', () => {
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
});
