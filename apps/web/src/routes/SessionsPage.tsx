import { useEffect, useState } from 'react';
import { SkeletonTableRows } from '../components/Skeleton.js';
import { api, ApiRequestError } from '../lib/api.js';

interface SessionRow {
  id: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  expiresAt: string;
}

// Spec §3.1.1: "Session list and remote revocation in user settings —
// 'sign out all other devices'." Self-service only — GET /auth/sessions
// is already scoped to the caller's own rows server-side, so there's no
// permission gate here the way Users/Roles have (every authenticated
// user manages their own devices, nothing more).
export function SessionsPage() {
  const [sessions, setSessions] = useState<SessionRow[] | 'loading' | 'error'>('loading');
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setSessions('loading');
    api
      .get<{ sessions: SessionRow[] }>('/auth/sessions')
      .then((res) => setSessions(res.sessions))
      .catch(() => setSessions('error'));
  }

  useEffect(load, []);

  async function revoke(id: string) {
    setError(null);
    setRevokingId(id);
    try {
      await api.post(`/auth/sessions/${id}/revoke`);
      setSessions((prev) => (Array.isArray(prev) ? prev.filter((s) => s.id !== id) : prev));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not revoke session.');
    } finally {
      setRevokingId(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold">Sessions</h1>
      <p className="text-sm text-gray-600">
        Every device currently signed in as you. Revoking a session signs that device out immediately — its next
        request is rejected and it has to log in again. The API has no way to tell which row is the one you're
        using right now, so double-check the IP/device details before revoking.
      </p>

      {sessions === 'loading' && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <tbody>
              <SkeletonTableRows rows={2} columns={5} />
            </tbody>
          </table>
        </div>
      )}
      {sessions === 'error' && <p role="alert">Could not load sessions.</p>}
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}

      {/* Real bug found live-testing, 2026-08-31 (mobile pass, spec §11
          M6): this table had no overflow-x-auto wrapper — on a real
          phone viewport the unbroken "Signed in"/"Expires" locale
          datetime strings pushed the whole page 651px wide inside a
          375px window instead of scrolling within its own bounds. */}
      {Array.isArray(sessions) && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-gray-500">
                <th className="py-2 pr-4 font-medium">IP</th>
                <th className="py-2 pr-4 font-medium">Device</th>
                <th className="py-2 pr-4 font-medium">Signed in</th>
                <th className="py-2 pr-4 font-medium">Expires</th>
                <th className="py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((session) => (
                <tr key={session.id} className="border-b border-gray-100">
                  <td className="py-2 pr-4">{session.ip ?? '—'}</td>
                  <td className="max-w-xs truncate py-2 pr-4" title={session.userAgent ?? undefined}>
                    {session.userAgent ?? '—'}
                  </td>
                  <td className="whitespace-nowrap py-2 pr-4">{new Date(session.createdAt).toLocaleString()}</td>
                  <td className="whitespace-nowrap py-2 pr-4">{new Date(session.expiresAt).toLocaleString()}</td>
                  <td className="py-2">
                    <button
                      onClick={() => void revoke(session.id)}
                      disabled={revokingId === session.id}
                      className="text-sm text-red-700 hover:underline disabled:opacity-50"
                    >
                      {revokingId === session.id ? 'Revoking…' : 'Revoke'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
