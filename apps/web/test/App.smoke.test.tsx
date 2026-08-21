import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.js';

describe('App smoke test', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        json: () =>
          Promise.resolve({
            status: 'ok',
            adapters: { realtime: 'supabase', storage: 'supabase' },
          }),
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the health status once the api responds', async () => {
    render(<App />);

    expect(screen.getByText(/Checking API/i)).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByTestId('health-status')).toHaveTextContent('ok');
    });
  });
});
