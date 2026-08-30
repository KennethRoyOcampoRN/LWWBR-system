import { Component, type ReactNode } from 'react';

// Spec §11 M6: "error boundaries." Confirmed 2026-08-26: there was no
// React error boundary anywhere in this app — an unhandled render error
// white-screened the whole thing with no recovery path. React still has
// no hook-based way to catch a render error as of React 19
// (getDerivedStateFromError/componentDidCatch are class-only), so this
// is a small hand-rolled class component rather than a new dependency —
// a full library is unwarranted for one component this size.
//
// Two ways to use it, by which prop is passed:
// - No `fallback`: the default full-screen "Something went wrong" block
//   with a Reload button — for page-level use, where the safest
//   universal recovery is a full reload (state may be genuinely
//   corrupted).
// - `fallback` (a render-prop, given the error and a `reset` callback):
//   for widget-level use, where a lighter "Try again" that just
//   unmounts/remounts the children (via `reset`) is enough, and a full
//   page reload would be overkill for isolating one broken widget among
//   several independent ones.
//
// `resetKey`: when provided, changing it (e.g. a route pathname) clears
// a caught error automatically — the boundary at AppShell's Outlet uses
// this so navigating away from a broken page recovers without a manual
// reload.
interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: (error: Error, reset: () => void) => ReactNode;
  resetKey?: unknown;
}

interface ErrorBoundaryState {
  error: Error | null;
}

// A small, compact fallback for widget-level boundaries (Dashboard's
// three simultaneous widgets, the WorkOrders detail drawer) — reused
// across all of them rather than each call site writing its own inline
// JSX for the same "Try again" pattern.
export function WidgetError({ label, reset }: { label: string; reset: () => void }) {
  return (
    <div className="rounded border border-red-200 bg-red-50 p-3 text-sm">
      <p className="text-red-800">{label} failed to load.</p>
      <button type="button" onClick={reset} className="mt-1 text-xs font-medium text-red-700 underline">
        Try again
      </button>
    </div>
  );
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error): void {
    // Same "log, don't throw further" convention as this app's other
    // best-effort failure paths (e.g. realtime broadcast errors) —
    // console.error is the only sink available client-side; there's no
    // error-reporting service wired up in this app.
    console.error('ErrorBoundary caught a render error:', error);
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.reset();
    }
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) {
      return this.props.children;
    }
    if (this.props.fallback) {
      return this.props.fallback(error, this.reset);
    }
    return (
      <div className="flex flex-col items-center gap-3 rounded border border-red-200 bg-red-50 p-8 text-center">
        <h1 className="text-lg font-semibold text-red-900">Something went wrong</h1>
        <p className="text-sm text-red-700">
          This page hit an unexpected error. Reloading usually fixes it — if it keeps happening, let your system
          admin know.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded bg-red-700 px-4 py-2 text-sm font-medium text-white"
        >
          Reload page
        </button>
      </div>
    );
  }
}
