import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext.js';
import { api } from '../lib/api.js';
import { subscribeToNotifications, type NotificationPayload, type RealtimeConnectionStatus } from '../lib/realtime.js';

interface NotificationRow {
  id: string;
  type: string;
  title: string;
  body: string;
  entityType: string | null;
  entityId: string | null;
  readAt: string | null;
  createdAt: string;
}

const POLL_INTERVAL_MS = 60_000;

// Spec §9: GET /notifications, POST /notifications/:id/read — and §9.1's
// notification.new event, emitted on this user's own user:{id} channel
// (assigned-to-you, reopened-on-you) and their dept:{department} channel
// (urgent tickets filed for their department, §7.2). Lives in AppShell's
// nav rail rather than as a routed page — every screen should show it,
// same reasoning as the Sign out button's placement.
export function NotificationBell() {
  const { user } = useAuth();
  const [notifications, setNotifications] = useState<NotificationRow[]>([]);
  const [open, setOpen] = useState(false);
  const [realtimeStatus, setRealtimeStatus] = useState<RealtimeConnectionStatus>('connecting');
  const containerRef = useRef<HTMLDivElement>(null);

  const fetchNotifications = useCallback(() => {
    return api
      .get<{ notifications: NotificationRow[] }>('/notifications')
      .then((res) => setNotifications(res.notifications))
      .catch(() => {
        // Best-effort — the bell just stays at its last-known state on a
        // transient fetch failure rather than surfacing an error UI for
        // what's a secondary, non-blocking feature.
      });
  }, []);

  useEffect(() => {
    void fetchNotifications();
  }, [fetchNotifications]);

  // Fallback recovery path, same principle as UnitsPage's poll (spec §3:
  // "a dropped socket must never leave a stale board with no recovery
  // path") — a missed realtime event still surfaces within a minute.
  useEffect(() => {
    const interval = setInterval(() => void fetchNotifications(), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchNotifications]);

  useEffect(() => {
    if (!user) {
      return;
    }
    const unsubscribe = subscribeToNotifications(
      user.id,
      user.department,
      (payload: NotificationPayload) => {
        setNotifications((prev) => [
          {
            id: payload.entityId,
            type: payload.type,
            title: payload.title,
            body: payload.body,
            entityType: payload.relatedEntityType,
            entityId: payload.relatedEntityId,
            readAt: null,
            createdAt: payload.at,
          },
          ...prev,
        ]);
      },
      setRealtimeStatus,
    );
    return unsubscribe;
  }, [user]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  if (!user) {
    return null;
  }

  const unreadCount = notifications.filter((n) => !n.readAt).length;

  const markRead = (id: string) => {
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, readAt: new Date().toISOString() } : n)));
    api.post(`/notifications/${id}/read`).catch(() => {
      // Best-effort — a failed mark-read just means it'll show unread
      // again on the next fetch; not worth surfacing as an error.
    });
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="Notifications"
        className="relative flex items-center gap-1 rounded px-2 py-1 text-sm font-medium text-gray-700 hover:bg-gray-100"
      >
        <span aria-hidden="true">🔔</span>
        {realtimeStatus === 'reconnecting' && (
          <span className="hidden text-xs text-amber-600 md:inline">Reconnecting…</span>
        )}
        {unreadCount > 0 && (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold text-white">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 z-10 mt-2 w-80 rounded border border-gray-200 bg-white shadow-lg md:left-0 md:right-auto">
          <p className="border-b border-gray-100 px-3 py-2 text-xs font-semibold text-gray-500">Notifications</p>
          {notifications.length === 0 ? (
            <p className="px-3 py-4 text-sm text-gray-500">Nothing yet.</p>
          ) : (
            <ul className="max-h-96 overflow-y-auto">
              {notifications.map((n) => (
                <li key={n.id}>
                  <button
                    onClick={() => markRead(n.id)}
                    className={`block w-full border-b border-gray-50 px-3 py-2 text-left text-sm last:border-b-0 ${
                      n.readAt ? 'text-gray-500' : 'bg-blue-50 font-medium text-gray-900'
                    } hover:bg-gray-50`}
                  >
                    <p>{n.title}</p>
                    <p className="text-xs font-normal text-gray-500">{n.body}</p>
                    <p className="text-xs font-normal text-gray-400">{new Date(n.createdAt).toLocaleString()}</p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
