// Realtime transport interface — spec §3 / §9.1. App code emits domain
// events through this interface and never imports Socket.IO or
// @supabase/supabase-js directly. MVP ships the Supabase implementation
// only (spec §3.1); a self-hosted Socket.IO implementation is not built.

export interface RealtimeEventPayload {
  entityId: string;
  actorId: string;
  at: string; // ISO 8601 UTC
  summary: string;
  [key: string]: unknown;
}

/**
 * Channel naming follows spec §9.1: `user:{id}`, `dept:{department}`,
 * `property`.
 */
export type RealtimeChannel = string;

export interface RealtimeAdapter {
  emit(channel: RealtimeChannel, event: string, payload: RealtimeEventPayload): Promise<void>;
}
