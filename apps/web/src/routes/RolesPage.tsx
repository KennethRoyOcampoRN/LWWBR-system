import { PERMISSION_SCOPES, type PermissionKey, type PermissionScope } from '@lwwbr/shared';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Button } from '../components/Button.js';
import { Card } from '../components/Card.js';
import { Field, INPUT_CLASSES } from '../components/Field.js';
import { PageHeader } from '../components/PageHeader.js';
import { SkeletonList } from '../components/Skeleton.js';
import { BODY, CAPTION, SECTION_TITLE } from '../components/typography.js';
import { api, ApiRequestError } from '../lib/api.js';

interface RoleRow {
  id: string;
  key: string;
  label: string;
  description: string | null;
  isSystem: boolean;
  permissions: Partial<Record<PermissionKey, PermissionScope>>;
}

interface PermissionRow {
  key: PermissionKey;
  group: string;
  description: string | null;
}

const SCOPE_OPTIONS = ['NONE', ...PERMISSION_SCOPES] as const;

function NewRoleForm({ onCreated }: { onCreated: (role: RoleRow) => void }) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const res = await api.post<{ role: RoleRow }>('/roles', { key, label });
      onCreated(res.role);
      setKey('');
      setLabel('');
      setOpen(false);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not create role.');
    }
  }

  if (!open) {
    return (
      <Button type="button" onClick={() => setOpen(true)} className="self-start">
        + New role
      </Button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3 rounded-xl border border-gray-200 p-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Key (UPPER_SNAKE_CASE)">
          <input
            className={INPUT_CLASSES}
            value={key}
            onChange={(e) => setKey(e.target.value.toUpperCase())}
            required
          />
        </Field>
        <Field label="Label">
          <input className={INPUT_CLASSES} value={label} onChange={(e) => setLabel(e.target.value)} required />
        </Field>
      </div>
      {error && (
        <p role="alert" className="text-sm font-medium text-danger-600">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit">Create</Button>
        <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function PermissionEditor({
  role,
  permissions,
  onSaved,
}: {
  role: RoleRow;
  permissions: PermissionRow[];
  onSaved: (role: RoleRow) => void;
}) {
  const [grants, setGrants] = useState<Partial<Record<PermissionKey, PermissionScope | 'NONE'>>>(() => {
    const initial: Partial<Record<PermissionKey, PermissionScope | 'NONE'>> = {};
    for (const p of permissions) {
      initial[p.key] = role.permissions[p.key] ?? 'NONE';
    }
    return initial;
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const grouped = useMemo(() => {
    const byGroup = new Map<string, PermissionRow[]>();
    for (const p of permissions) {
      const list = byGroup.get(p.group) ?? [];
      list.push(p);
      byGroup.set(p.group, list);
    }
    return [...byGroup.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [permissions]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const grantList = Object.entries(grants)
        .filter(([, scope]) => scope !== 'NONE')
        .map(([permissionKey, scope]) => ({ permissionKey, scope }));
      const res = await api.put<{ role: RoleRow }>(`/roles/${role.id}/permissions`, { grants: grantList });
      onSaved(res.role);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not save permissions.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {grouped.map(([group, items]) => (
        <div key={group}>
          <p className={`mb-1 ${CAPTION} font-semibold uppercase tracking-wide`}>{group}</p>
          <div className="flex flex-col gap-1">
            {items.map((p) => (
              <div key={p.key} className="flex items-center justify-between gap-2 border-b border-gray-100 py-1.5 text-sm">
                <span className="font-mono text-xs text-ink-secondary">{p.key}</span>
                <select
                  className={`${INPUT_CLASSES} text-xs`}
                  value={grants[p.key] ?? 'NONE'}
                  onChange={(e) =>
                    setGrants((prev) => ({ ...prev, [p.key]: e.target.value as PermissionScope | 'NONE' }))
                  }
                >
                  {SCOPE_OPTIONS.map((scope) => (
                    <option key={scope} value={scope}>
                      {scope}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </div>
      ))}
      {error && (
        <p role="alert" className="text-sm font-medium text-danger-600">
          {error}
        </p>
      )}
      <Button type="button" onClick={() => void save()} disabled={saving} className="self-start">
        Save permissions
      </Button>
    </div>
  );
}

// Visual redesign, round 2 (spec.md §13 decision 40, 2026-11-20):
// converted from hand-typed headings/buttons/inputs to the shared
// primitives (PageHeader, Button, Field/INPUT_CLASSES, Card, the type
// scale) — this page had two responsive breakpoints before this round
// and none of its own colors routed through the brand/semantic tokens.
export function RolesPage() {
  const [roles, setRoles] = useState<RoleRow[] | 'loading' | 'error'>('loading');
  const [permissions, setPermissions] = useState<PermissionRow[]>([]);
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      api.get<{ roles: RoleRow[] }>('/roles'),
      api.get<{ permissions: PermissionRow[] }>('/permissions'),
    ])
      .then(([rolesRes, permissionsRes]) => {
        setRoles(rolesRes.roles);
        setPermissions(permissionsRes.permissions);
      })
      .catch(() => setRoles('error'));
  }, []);

  function handleRoleCreated(role: RoleRow) {
    setRoles((prev) => (Array.isArray(prev) ? [...prev, role] : prev));
  }

  function handlePermissionsSaved(updated: RoleRow) {
    setRoles((prev) => (Array.isArray(prev) ? prev.map((r) => (r.id === updated.id ? updated : r)) : prev));
  }

  const selectedRole = Array.isArray(roles) ? roles.find((r) => r.id === selectedRoleId) : undefined;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Roles" description="Who can do what — grouped permissions per role." />

      <NewRoleForm onCreated={handleRoleCreated} />

      {roles === 'loading' && <SkeletonList />}
      {roles === 'error' && <p role="alert">Could not load roles.</p>}

      {Array.isArray(roles) && (
        <div className="flex flex-col gap-4 md:flex-row">
          <ul className="flex shrink-0 flex-col gap-1 md:w-56">
            {roles.map((role) => (
              <li key={role.id}>
                <button
                  onClick={() => setSelectedRoleId(role.id)}
                  className={`w-full rounded-xl px-3 py-2 text-left text-sm transition-colors ${
                    selectedRoleId === role.id ? 'bg-brand-600 text-white' : 'text-ink-secondary hover:bg-brand-50 hover:text-brand-700'
                  }`}
                >
                  {role.label}
                  {!role.isSystem && <span className="ml-1 text-xs opacity-70">(custom)</span>}
                </button>
              </li>
            ))}
          </ul>

          <Card className="flex-1">
            {selectedRole ? (
              <>
                <h2 className={`mb-3 ${SECTION_TITLE}`}>{selectedRole.label}</h2>
                <PermissionEditor role={selectedRole} permissions={permissions} onSaved={handlePermissionsSaved} />
              </>
            ) : (
              <p className={BODY}>Select a role to edit its permissions.</p>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
