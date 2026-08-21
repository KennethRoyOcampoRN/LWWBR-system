import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { RealtimeAdapter, RealtimeChannel, RealtimeEventPayload } from './types.js';

export class SupabaseRealtimeAdapter implements RealtimeAdapter {
  private readonly client: SupabaseClient;

  constructor(supabaseUrl: string, serviceRoleKey: string) {
    this.client = createClient(supabaseUrl, serviceRoleKey);
  }

  async emit(
    channel: RealtimeChannel,
    event: string,
    payload: RealtimeEventPayload,
  ): Promise<void> {
    const rtChannel = this.client.channel(channel);
    const response = await rtChannel.send({
      type: 'broadcast',
      event,
      payload,
    });
    await this.client.removeChannel(rtChannel);

    if (response !== 'ok') {
      throw new Error(`Realtime broadcast to "${channel}" failed: ${response}`);
    }
  }
}
