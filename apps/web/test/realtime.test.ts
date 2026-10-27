import { beforeEach, describe, expect, it, vi } from 'vitest';

// Client decision, 2026-10-27 (spec.md §13 decision 11): Socket.IO
// replaces Supabase Realtime as the transport — this mocks the thin
// socket.io-client wrapper the same way the pre-swap test mocked
// @supabase/supabase-js, so no real (or fake) server connection is
// needed to exercise subscribeToUnitStatusChanges' own logic.
const mockSocket = {
  connected: false,
  on: vi.fn(),
  off: vi.fn(),
};
const mockIo = vi.fn(() => mockSocket);

vi.mock('socket.io-client', () => ({ io: mockIo }));

describe('subscribeToUnitStatusChanges', () => {
  beforeEach(() => {
    vi.resetModules();
    mockIo.mockClear();
    mockSocket.on.mockClear();
    mockSocket.off.mockClear();
    mockSocket.connected = false;
  });

  it('connects same-origin via the /rt path and reports "connecting" before the handshake completes', async () => {
    import.meta.env.VITE_REALTIME_DISABLED = undefined;
    const { subscribeToUnitStatusChanges } = await import('../src/lib/realtime.js');
    const onEvent = vi.fn();
    const onStatusChange = vi.fn();

    subscribeToUnitStatusChanges(onEvent, onStatusChange);

    expect(mockIo).toHaveBeenCalledWith(expect.objectContaining({ path: '/rt', withCredentials: true }));
    expect(onStatusChange).toHaveBeenCalledWith('connecting');
    expect(mockSocket.on).toHaveBeenCalledWith('unit.status.changed', expect.any(Function));
  });

  it('unsubscribe removes exactly this subscription\'s listeners, not the shared socket', async () => {
    import.meta.env.VITE_REALTIME_DISABLED = undefined;
    const { subscribeToUnitStatusChanges } = await import('../src/lib/realtime.js');
    const unsubscribe = subscribeToUnitStatusChanges(vi.fn(), vi.fn());

    unsubscribe();

    expect(mockSocket.off).toHaveBeenCalledWith('unit.status.changed', expect.any(Function));
    expect(mockSocket.off).toHaveBeenCalledWith('connect', expect.any(Function));
    expect(mockSocket.off).toHaveBeenCalledWith('disconnect', expect.any(Function));
  });

  // VITE_REALTIME_DISABLED is the explicit opt-out (a test harness, or a
  // deployment that genuinely wants realtime off); the 60s poll fallback
  // in UnitsPage still keeps the grid current either way.
  it('degrades to disabled without ever calling io() when VITE_REALTIME_DISABLED is set', async () => {
    import.meta.env.VITE_REALTIME_DISABLED = 'true';
    const { subscribeToUnitStatusChanges } = await import('../src/lib/realtime.js');
    const onEvent = vi.fn();
    const onStatusChange = vi.fn();

    expect(() => subscribeToUnitStatusChanges(onEvent, onStatusChange)).not.toThrow();
    expect(onStatusChange).toHaveBeenCalledWith('disabled');
    expect(mockIo).not.toHaveBeenCalled();
  });
});
