import { DEPARTMENT_KEYS, ROLE_KEYS, ROLE_LABELS, type DepartmentKey, type RoleKey } from '@lwwbr/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '../components/Button.js';
import { Field, INPUT_CLASSES } from '../components/Field.js';
import { PageHeader } from '../components/PageHeader.js';
import { SkeletonTableRows } from '../components/Skeleton.js';
import { StatusBadge } from '../components/StatusBadge.js';
import { api, ApiRequestError } from '../lib/api.js';

interface UserRow {
  id: string;
  employeeCode: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  department: DepartmentKey;
  isActive: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  roles: RoleKey[];
}

function RoleCheckboxes({ selected, onChange }: { selected: RoleKey[]; onChange: (roles: RoleKey[]) => void }) {
  return (
    <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
      {ROLE_KEYS.map((key) => (
        <label key={key} className="flex items-center gap-1 text-xs text-ink-secondary">
          <input
            type="checkbox"
            checked={selected.includes(key)}
            onChange={(e) =>
              onChange(e.target.checked ? [...selected, key] : selected.filter((role) => role !== key))
            }
          />
          {ROLE_LABELS[key]}
        </label>
      ))}
    </div>
  );
}

function NewUserForm({ onCreated }: { onCreated: (user: UserRow, tempPassword: string) => void }) {
  const [open, setOpen] = useState(false);
  const [employeeCode, setEmployeeCode] = useState('');
  const [fullName, setFullName] = useState('');
  const [department, setDepartment] = useState<DepartmentKey>('MANAGEMENT');
  const [roleKeys, setRoleKeys] = useState<RoleKey[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await api.post<{ user: UserRow; tempPassword: string }>('/users', {
        employeeCode,
        fullName,
        department,
        roleKeys,
      });
      onCreated(res.user, res.tempPassword);
      setEmployeeCode('');
      setFullName('');
      setRoleKeys([]);
      setOpen(false);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not create user.');
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) {
    return (
      <Button type="button" onClick={() => setOpen(true)} className="self-start">
        + New user
      </Button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3 rounded-xl border border-gray-200 p-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Employee code">
          <input className={INPUT_CLASSES} value={employeeCode} onChange={(e) => setEmployeeCode(e.target.value)} required />
        </Field>
        <Field label="Full name">
          <input className={INPUT_CLASSES} value={fullName} onChange={(e) => setFullName(e.target.value)} required />
        </Field>
        <Field label="Department">
          <select className={INPUT_CLASSES} value={department} onChange={(e) => setDepartment(e.target.value as DepartmentKey)}>
            {DEPARTMENT_KEYS.map((key) => (
              <option key={key} value={key}>
                {key}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Roles">
        <RoleCheckboxes selected={roleKeys} onChange={setRoleKeys} />
      </Field>
      {error && (
        <p role="alert" className="text-sm font-medium text-danger-600">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={submitting || roleKeys.length === 0}>
          Create
        </Button>
        <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function UserRowEditor({ user, onSaved }: { user: UserRow; onSaved: (user: UserRow) => void }) {
  const [editing, setEditing] = useState(false);
  const [fullName, setFullName] = useState(user.fullName);
  const [isActive, setIsActive] = useState(user.isActive);
  const [roleKeys, setRoleKeys] = useState<RoleKey[]>(user.roles);
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    try {
      const res = await api.patch<{ user: UserRow }>(`/users/${user.id}`, { fullName, isActive, roleKeys });
      onSaved(res.user);
      setEditing(false);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not save.');
    }
  }

  async function resetPassword() {
    setError(null);
    try {
      const res = await api.post<{ tempPassword: string }>(`/users/${user.id}/reset-password`);
      setTempPassword(res.tempPassword);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not reset password.');
    }
  }

  if (!editing) {
    return (
      <tr className="border-b border-gray-100">
        <td className="py-2 pl-3 pr-4 font-mono text-xs">{user.employeeCode}</td>
        <td className="py-2 pr-4">{user.fullName}</td>
        <td className="py-2 pr-4 text-ink-secondary">{user.department}</td>
        <td className="py-2 pr-4 text-ink-secondary">{user.roles.map((key) => ROLE_LABELS[key]).join(', ')}</td>
        <td className="py-2 pr-4">
          <StatusBadge variant={user.isActive ? 'success' : 'neutral'}>{user.isActive ? 'Active' : 'Disabled'}</StatusBadge>
        </td>
        <td className="flex gap-3 py-2">
          <button onClick={() => setEditing(true)} className="text-sm font-medium text-brand-700 hover:underline">
            Edit
          </button>
          <button onClick={() => void resetPassword()} className="text-sm font-medium text-brand-700 hover:underline">
            Reset password
          </button>
        </td>
      </tr>
    );
  }

  return (
    <tr className="border-b border-gray-100 align-top">
      <td className="py-2 pl-3 pr-4 font-mono text-xs">{user.employeeCode}</td>
      <td className="py-2 pr-4" colSpan={4}>
        <div className="flex flex-col gap-2">
          <input className={`${INPUT_CLASSES} text-sm`} value={fullName} onChange={(e) => setFullName(e.target.value)} />
          <label className="flex items-center gap-1 text-sm text-ink-secondary">
            <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
            Active
          </label>
          <RoleCheckboxes selected={roleKeys} onChange={setRoleKeys} />
          {tempPassword && (
            <p className="text-sm text-success-600">
              New temporary password: <span className="font-mono">{tempPassword}</span> (shown once — relay it to
              the user now)
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm font-medium text-danger-600">
              {error}
            </p>
          )}
        </div>
      </td>
      <td className="flex gap-3 py-2">
        <button
          onClick={() => void save()}
          disabled={roleKeys.length === 0}
          className="text-sm font-medium text-brand-700 hover:underline disabled:opacity-50"
        >
          Save
        </button>
        <button onClick={() => setEditing(false)} className="text-sm font-medium text-ink-secondary hover:underline">
          Cancel
        </button>
      </td>
    </tr>
  );
}

// Visual redesign, round 2 (spec.md §13 decision 40, 2026-11-20):
// converted headings/buttons/inputs/status text to the shared
// primitives. Kept as a hand-rolled <table>, not DataTable — the inline
// edit row replaces four columns with one colSpan block, a shape
// DataTable's per-column render doesn't support; the existing
// overflow-x-auto wrapper (added 2026-08-31) already covers phone
// width.
export function UsersPage() {
  const [users, setUsers] = useState<UserRow[] | 'loading' | 'error'>('loading');
  const [createdTempPassword, setCreatedTempPassword] = useState<{ employeeCode: string; password: string } | null>(
    null,
  );

  useEffect(() => {
    api
      .get<{ users: UserRow[] }>('/users')
      .then((res) => setUsers(res.users))
      .catch(() => setUsers('error'));
  }, []);

  function handleCreated(user: UserRow, tempPassword: string) {
    setUsers((prev) => (Array.isArray(prev) ? [...prev, user] : prev));
    setCreatedTempPassword({ employeeCode: user.employeeCode, password: tempPassword });
  }

  function handleSaved(updated: UserRow) {
    setUsers((prev) => (Array.isArray(prev) ? prev.map((u) => (u.id === updated.id ? updated : u)) : prev));
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Users" description="Front-office, housekeeping, maintenance, and admin accounts." />

      {createdTempPassword && (
        <div className="rounded-xl border border-success-600/30 bg-success-50 p-3 text-sm text-success-600">
          Created <strong>{createdTempPassword.employeeCode}</strong> with temporary password{' '}
          <span className="font-mono">{createdTempPassword.password}</span> — shown once, relay it to the new hire
          now.
        </div>
      )}

      <NewUserForm onCreated={handleCreated} />

      {users === 'loading' && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <tbody>
              <SkeletonTableRows rows={4} columns={6} />
            </tbody>
          </table>
        </div>
      )}
      {users === 'error' && <p role="alert">Could not load users.</p>}
      {Array.isArray(users) && (
        <div className="overflow-x-auto rounded-xl border border-gray-200">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-ink-secondary">
                <th className="px-3 py-2 font-medium">Code</th>
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Department</th>
                <th className="px-3 py-2 font-medium">Roles</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <UserRowEditor key={user.id} user={user} onSaved={handleSaved} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
