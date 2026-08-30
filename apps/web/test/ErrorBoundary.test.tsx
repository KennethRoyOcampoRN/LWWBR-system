import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary, WidgetError } from '../src/components/ErrorBoundary.js';

function Bomb({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) {
    throw new Error('boom');
  }
  return <p>All good</p>;
}

describe('ErrorBoundary', () => {
  let reloadSpy: ReturnType<typeof vi.fn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // React logs the caught error to the console itself in dev mode,
    // on top of this component's own componentDidCatch log — silence
    // both so the test output isn't misleading about a real failure.
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    reloadSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { ...window.location, reload: reloadSpy },
      writable: true,
    });
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('renders children normally when nothing throws', () => {
    render(
      <ErrorBoundary>
        <Bomb shouldThrow={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByText('All good')).toBeInTheDocument();
  });

  it('catches a render error and shows the default full-screen fallback with a Reload button', async () => {
    const user = userEvent.setup();
    render(
      <ErrorBoundary>
        <Bomb shouldThrow={true} />
      </ErrorBoundary>,
    );

    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.queryByText('All good')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Reload page' }));
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it('renders a custom fallback render-prop instead of the default, and its reset() clears the error', async () => {
    const user = userEvent.setup();

    function Harness() {
      const [shouldThrow, setShouldThrow] = useState(true);
      return (
        <ErrorBoundary
          fallback={(error, reset) => (
            <div>
              <p>Widget broke: {error.message}</p>
              <button
                onClick={() => {
                  setShouldThrow(false);
                  reset();
                }}
              >
                Try again
              </button>
            </div>
          )}
        >
          <Bomb shouldThrow={shouldThrow} />
        </ErrorBoundary>
      );
    }

    render(<Harness />);
    expect(screen.getByText('Widget broke: boom')).toBeInTheDocument();
    expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('All good')).toBeInTheDocument();
  });

  it('auto-recovers when resetKey changes, without needing a manual reset', async () => {
    const user = userEvent.setup();

    function Harness() {
      const [key, setKey] = useState('a');
      const [shouldThrow, setShouldThrow] = useState(true);
      return (
        <div>
          <button
            onClick={() => {
              setShouldThrow(false);
              setKey('b');
            }}
          >
            Navigate away
          </button>
          <ErrorBoundary resetKey={key}>
            <Bomb shouldThrow={shouldThrow} />
          </ErrorBoundary>
        </div>
      );
    }

    render(<Harness />);
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Navigate away' }));
    expect(screen.getByText('All good')).toBeInTheDocument();
    expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
  });
});

describe('WidgetError', () => {
  it('shows the labelled failure message and calls reset when Try again is clicked', async () => {
    const user = userEvent.setup();
    const reset = vi.fn();
    render(<WidgetError label="Attention queue" reset={reset} />);

    expect(screen.getByText('Attention queue failed to load.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
