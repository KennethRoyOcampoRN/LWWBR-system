import { io, type Socket } from 'socket.io-client';

// Client decision, 2026-10-27 (spec.md §13 decision 11): local self-
// hosting on a mini PC — Socket.IO per spec §9.1's original design
// (namespace /rt), not Supabase Realtime. Same exported functions, same
// payload shapes, same connecting/connected/reconnecting/disabled status
// contract as before this swap, so nothing calling these (UnitsPage,
// FnbPage, the notification bell) needed to change at all — only what's
// underneath changed. Auth happens server-side at the socket handshake
// (apps/api's socketIoServer.ts reads the same access-token cookie
// requireAuth does, since a same-origin WebSocket carries cookies
// automatically) — this client never sends credentials of its own.
export interface UnitStatusChangedPayload {
  entityId: string;
  actorId: string;
  at: string;
  summary: string;
  fromStatus: string;
  toStatus: string;
  version: number;
  note: string | null;
}

// Connection health for the drawer/grid's "reconnecting" indicator (spec
// §3's resiliency rule: "a dropped socket must never leave a stale board
// with no recovery path"). 'disabled' is reachable only via VITE_REALTIME_
// DISABLED (an explicit opt-out, e.g. for a test harness); ordinarily the
// socket always attempts to connect, same-origin, no separate config
// needed — the 60s poll fallback in UnitsPage still keeps the grid
// current regardless of whether the socket is up.
export type RealtimeConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'disabled';

let cachedSocket: Socket | undefined | null;

function getSocket(): Socket | null {
  if (cachedSocket !== undefined) {
    return cachedSocket;
  }
  if (import.meta.env.VITE_REALTIME_DISABLED === 'true') {
    cachedSocket = null;
    return cachedSocket;
  }
  cachedSocket = io({ path: '/rt', withCredentials: true, autoConnect: true });
  return cachedSocket;
}

// Spec §9.1: `unit.status.changed`, emitted on the `property` channel —
// this is the browser-side payload shape apps/api's units/service.ts
// broadcasts after every unit status write (normal, override, or forced
// correction).
export function subscribeToUnitStatusChanges(
  onEvent: (payload: UnitStatusChangedPayload) => void,
  onStatusChange: (status: RealtimeConnectionStatus) => void,
): () => void {
  const socket = getSocket();
  if (!socket) {
    onStatusChange('disabled');
    return () => {};
  }

  onStatusChange(socket.connected ? 'connected' : 'connecting');
  const handleEvent = (payload: UnitStatusChangedPayload) => onEvent(payload);
  const handleConnect = () => onStatusChange('connected');
  const handleDisconnect = () => onStatusChange('reconnecting');

  socket.on('unit.status.changed', handleEvent);
  socket.on('connect', handleConnect);
  socket.on('disconnect', handleDisconnect);
  socket.on('reconnect_attempt', handleDisconnect);

  return () => {
    socket.off('unit.status.changed', handleEvent);
    socket.off('connect', handleConnect);
    socket.off('disconnect', handleDisconnect);
    socket.off('reconnect_attempt', handleDisconnect);
  };
}

// Spec §9.1: `notification.new`, emitted on either a `user:{id}` channel
// (a notification targeted at one person) or a `dept:{department}`
// channel (everyone in a target department, §7.2). The server already
// joins both rooms for every connected socket at handshake time
// (socketIoServer.ts), so the browser doesn't need to request them.
export interface NotificationPayload {
  entityId: string;
  actorId: string;
  at: string;
  summary: string;
  type: string;
  title: string;
  body: string;
  relatedEntityType: string | null;
  relatedEntityId: string | null;
}

/**
 * Subscribes to the `property` channel's `fnb.order.created` and
 * `fnb.order.status.changed` broadcasts. Same disabled/connecting/
 * connected/reconnecting status contract and cleanup-safety as
 * subscribeToUnitStatusChanges.
 */
export interface FnbOrderChangedPayload {
  entityId: string;
  actorId: string;
  at: string;
  summary: string;
}

export function subscribeToFnbOrderChanges(
  onEvent: (payload: FnbOrderChangedPayload) => void,
  onStatusChange: (status: RealtimeConnectionStatus) => void,
): () => void {
  const socket = getSocket();
  if (!socket) {
    onStatusChange('disabled');
    return () => {};
  }

  onStatusChange(socket.connected ? 'connected' : 'connecting');
  const handleEvent = (payload: FnbOrderChangedPayload) => onEvent(payload);
  const handleConnect = () => onStatusChange('connected');
  const handleDisconnect = () => onStatusChange('reconnecting');

  socket.on('fnb.order.created', handleEvent);
  socket.on('fnb.order.status.changed', handleEvent);
  socket.on('connect', handleConnect);
  socket.on('disconnect', handleDisconnect);
  socket.on('reconnect_attempt', handleDisconnect);

  return () => {
    socket.off('fnb.order.created', handleEvent);
    socket.off('fnb.order.status.changed', handleEvent);
    socket.off('connect', handleConnect);
    socket.off('disconnect', handleDisconnect);
    socket.off('reconnect_attempt', handleDisconnect);
  };
}

/**
 * Subscribes to `notification.new`. userId/department are accepted for
 * signature compatibility with the pre-swap API (and because the server
 * independently joins the caller to exactly these two rooms at handshake
 * time, from the verified token — never from what the client claims) —
 * this function doesn't need to tell the server anything, there's simply
 * nothing more to send; the socket connection itself is already scoped.
 */
export function subscribeToNotifications(
  _userId: string,
  _department: string,
  onEvent: (payload: NotificationPayload) => void,
  onStatusChange: (status: RealtimeConnectionStatus) => void,
): () => void {
  const socket = getSocket();
  if (!socket) {
    onStatusChange('disabled');
    return () => {};
  }

  onStatusChange(socket.connected ? 'connected' : 'connecting');
  const handleEvent = (payload: NotificationPayload) => onEvent(payload);
  const handleConnect = () => onStatusChange('connected');
  const handleDisconnect = () => onStatusChange('reconnecting');

  socket.on('notification.new', handleEvent);
  socket.on('connect', handleConnect);
  socket.on('disconnect', handleDisconnect);
  socket.on('reconnect_attempt', handleDisconnect);

  return () => {
    socket.off('notification.new', handleEvent);
    socket.off('connect', handleConnect);
    socket.off('disconnect', handleDisconnect);
    socket.off('reconnect_attempt', handleDisconnect);
  };
}
