import type { Server } from 'socket.io';
import type { RealtimeAdapter, RealtimeChannel, RealtimeEventPayload } from './types.js';

// Client decision, 2026-10-27 (spec.md §13 decision 11): local self-
// hosting on a mini PC — Socket.IO per spec §9.1's original pre-Supabase-
// pivot design (namespace /rt, same channel-as-room naming, same event
// names), not a newly invented transport. Socket.IO "rooms" map 1:1 onto
// this interface's RealtimeChannel strings, so emit() is a one-line
// translation — see socketIoServer.ts for how a channel is joined.
export class SocketIoRealtimeAdapter implements RealtimeAdapter {
  constructor(private readonly io: Server) {}

  async emit(channel: RealtimeChannel, event: string, payload: RealtimeEventPayload): Promise<void> {
    this.io.to(channel).emit(event, payload);
  }
}
