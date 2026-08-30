import { PERMISSION_SCOPES, type PermissionKey, type PermissionScope } from '@lwwbr/shared';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { SkeletonList } from '../components/Skeleton.js';
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
      <button onClick={() => setOpen(true)} className="self-start rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white">
        + New role
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3 rounded border border-gray-200 p-4">
      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-sm">
          Key (UPPER_SNAKE_CASE)
          <input
            className="rounded border border-gray-300 px-2 py-1"
            value={key}
            onChange={(e) => setKey(e.target.value.toUpperCase())}
            required
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Label
          <input
            className="rounded border border-gray-300 px-2 py-1"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            required
          />
        </label>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button type="submit" className="rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white">
          Create
        </button>
        <button type="button" onClick={() => setOpen(false)} className="rounded px-3 py-2 text-sm text-gray-600">
          Cancel
        </button>
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
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">{group}</p>
          <div className="flex flex-col gap-1">
            {items.map((p) => (
              <div key={p.key} className="flex items-center justify-between gap-2 text-sm">
                <span>{p.key}</span>
                <select
                  className="rounded border border-gray-300 px-2 py-1 text-xs"
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
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      <button
        onClick={() => void save()}
        disabled={saving}
        className="self-start rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        Save permissions
      </button>
    </div>
  );
}

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
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold">Roles</h1>

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
                  className={`w-full rounded px-3 py-2 text-left text-sm ${
                    selectedRoleId === role.id ? 'bg-blue-100 text-blue-800' : 'hover:bg-gray-100'
                  }`}
                >
                  {role.label}
                  {!role.isSystem && <span className="ml-1 text-xs text-gray-400">(custom)</span>}
                </button>
              </li>
            ))}
          </ul>

          <div className="flex-1">
            {selectedRole ? (
              <PermissionEditor role={selectedRole} permissions={permissions} onSaved={handlePermissionsSaved} />
            ) : (
              <p className="text-sm text-gray-500">Select a role to edit its permissions.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
