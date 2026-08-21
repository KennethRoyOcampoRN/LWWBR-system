import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { SupabaseRealtimeAdapter } from '../../src/adapters/realtime/supabaseRealtimeAdapter.js';

// UNVERIFIED IN THIS SESSION — see /README.md "M0 status". This test needs
// a running local Supabase stack (`supabase start`), which requires Docker
// and was not available in the environment this was written in. It has
// never been executed. Run it after `supabase start` to confirm the
// RealtimeAdapter round-trips against real Supabase Realtime.
const hasLocalSupabase = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);

describe.skipIf(!hasLocalSupabase)('SupabaseRealtimeAdapter round-trip', () => {
  const supabaseUrl = process.env.SUPABASE_URL as string;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY as string;

  it('a broadcast emitted through the adapter is received by a subscriber', async () => {
    const channelName = `test:m0-roundtrip-${Date.now()}`;
    const subscriber = createClient(supabaseUrl, serviceRoleKey);
    const channel = subscriber.channel(channelName);

    const received = new Promise<{ entityId: string; summary: string }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timed out waiting for broadcast')), 5000);
      channel.on('broadcast', { event: 'unit.status.changed' }, ({ payload }) => {
        clearTimeout(timeout);
        resolve(payload as { entityId: string; summary: string });
      });
    });

    await new Promise<void>((resolve, reject) => {
      channel.subscribe((status) => {
        if (status === 'SUBSCRIBED') resolve();
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          reject(new Error(`subscribe failed: ${status}`));
        }
      });
    });

    const adapter = new SupabaseRealtimeAdapter(supabaseUrl, serviceRoleKey);
    await adapter.emit(channelName, 'unit.status.changed', {
      entityId: 'unit_test',
      actorId: 'user_test',
      at: new Date().toISOString(),
      summary: 'Room R01 moved to CLEANING',
    });

    const payload = await received;
    expect(payload.entityId).toBe('unit_test');
    expect(payload.summary).toContain('R01');

    await subscriber.removeChannel(channel);
  });
});
