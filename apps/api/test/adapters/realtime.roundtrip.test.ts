import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { SupabaseRealtimeAdapter } from '../../src/adapters/realtime/supabaseRealtimeAdapter.js';

// Requires SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY for the hosted
// Supabase project (spec §3.1) in apps/api/.env — see .env.example.
// Skips cleanly if unset rather than failing.
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
