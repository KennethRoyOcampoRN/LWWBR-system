import { useEffect, useState } from 'react';
import { Button } from '../components/Button.js';
import { DataTable, type DataTableColumn } from '../components/DataTable.js';
import { PageHeader } from '../components/PageHeader.js';
import { Section } from '../components/Card.js';
import { SkeletonList } from '../components/Skeleton.js';
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
//
// Visual redesign, round 2 (spec.md §13 decision 40, 2026-11-20):
// converted to DataTable (no responsive breakpoint at all before this —
// a hand-rolled table that overflowed sideways on a phone) and
// PageHeader/Section, same primitives every other page now routes
// through.
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

  const columns: DataTableColumn<SessionRow>[] = [
    { key: 'ip', header: 'IP', render: (s) => s.ip ?? '—' },
    {
      key: 'device',
      header: 'Device',
      render: (s) => (
        <span className="block max-w-xs truncate" title={s.userAgent ?? undefined}>
          {s.userAgent ?? '—'}
        </span>
      ),
    },
    { key: 'createdAt', header: 'Signed in', render: (s) => new Date(s.createdAt).toLocaleString() },
    { key: 'expiresAt', header: 'Expires', render: (s) => new Date(s.expiresAt).toLocaleString() },
    {
      key: 'actions',
      header: '',
      render: (s) => (
        <Button type="button" variant="danger" onClick={() => void revoke(s.id)} disabled={revokingId === s.id}>
          {revokingId === s.id ? 'Revoking…' : 'Revoke'}
        </Button>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Sessions"
        description="Every device currently signed in as you. Revoking a session signs that device out immediately."
      />

      <Section
        description="The API has no way to tell which row is the one you're using right now, so double-check the IP/device details before revoking."
      >
        {error && (
          <p role="alert" className="text-sm font-medium text-danger-600">
            {error}
          </p>
        )}
        {sessions === 'loading' && <SkeletonList items={2} />}
        {sessions === 'error' && <p role="alert">Could not load sessions.</p>}
        {Array.isArray(sessions) && (
          <DataTable
            columns={columns}
            rows={sessions}
            rowKey={(s) => s.id}
            mobileTitle={(s) => s.ip ?? 'Unknown IP'}
            emptyMessage="No active sessions."
          />
        )}
      </Section>
    </div>
  );
}
