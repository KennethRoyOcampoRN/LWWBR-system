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
    // httpSend() delivers over REST explicitly rather than falling back to
    // it implicitly from send() (which logs a deprecation warning) — this
    // adapter never needs a websocket subscription of its own to emit.
    const rtChannel = this.client.channel(channel);
    try {
      await rtChannel.httpSend(event, payload);
    } catch (error) {
      throw new Error(
        `Realtime broadcast to "${channel}" failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      await this.client.removeChannel(rtChannel);
    }
  }
}
