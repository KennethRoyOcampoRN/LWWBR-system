import { beforeEach, describe, expect, it, vi } from 'vitest';

// Real bug, found live 2026-08-22: a leftover .env.example placeholder
// (`https://<project-ref>.supabase.co`) in .env crashed createClient()
// with an uncaught "Invalid supabaseUrl", taking the whole Units page
// down to a blank screen with no visible error — thrown synchronously
// from inside a React effect, no error boundary catches it. This must
// degrade to 'disabled' instead, the same way a missing env var does.
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => {
    throw new Error('Invalid supabaseUrl');
  }),
}));

describe('subscribeToUnitStatusChanges', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('degrades to disabled rather than throwing when VITE_SUPABASE_URL is still a placeholder', async () => {
    import.meta.env.VITE_SUPABASE_URL = 'https://<project-ref>.supabase.co';
    import.meta.env.VITE_SUPABASE_ANON_KEY = 'replace-with-anon-public-key';

    const { subscribeToUnitStatusChanges } = await import('../src/lib/realtime.js');
    const onEvent = vi.fn();
    const onStatusChange = vi.fn();

    expect(() => subscribeToUnitStatusChanges(onEvent, onStatusChange)).not.toThrow();
    expect(onStatusChange).toHaveBeenCalledWith('disabled');
  });
});
