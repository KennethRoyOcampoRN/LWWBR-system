import { DEPARTMENT_KEYS, ROLE_KEYS, ROLE_LABELS, type DepartmentKey, type RoleKey } from '@lwwbr/shared';
import { useEffect, useState, type FormEvent } from 'react';
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
        <label key={key} className="flex items-center gap-1 text-xs">
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
      <button onClick={() => setOpen(true)} className="self-start rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white">
        + New user
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3 rounded border border-gray-200 p-4">
      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-sm">
          Employee code
          <input
            className="rounded border border-gray-300 px-2 py-1"
            value={employeeCode}
            onChange={(e) => setEmployeeCode(e.target.value)}
            required
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Full name
          <input
            className="rounded border border-gray-300 px-2 py-1"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            required
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Department
          <select
            className="rounded border border-gray-300 px-2 py-1"
            value={department}
            onChange={(e) => setDepartment(e.target.value as DepartmentKey)}
          >
            {DEPARTMENT_KEYS.map((key) => (
              <option key={key} value={key}>
                {key}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div>
        <p className="mb-1 text-sm font-medium">Roles</p>
        <RoleCheckboxes selected={roleKeys} onChange={setRoleKeys} />
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={submitting || roleKeys.length === 0}
          className="rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          Create
        </button>
        <button type="button" onClick={() => setOpen(false)} className="rounded px-3 py-2 text-sm text-gray-600">
          Cancel
        </button>
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
        <td className="py-2 pr-4">{user.employeeCode}</td>
        <td className="py-2 pr-4">{user.fullName}</td>
        <td className="py-2 pr-4">{user.department}</td>
        <td className="py-2 pr-4">{user.roles.map((key) => ROLE_LABELS[key]).join(', ')}</td>
        <td className="py-2 pr-4">{user.isActive ? 'Active' : 'Disabled'}</td>
        <td className="flex gap-2 py-2">
          <button onClick={() => setEditing(true)} className="text-sm text-blue-700 hover:underline">
            Edit
          </button>
          <button onClick={() => void resetPassword()} className="text-sm text-blue-700 hover:underline">
            Reset password
          </button>
        </td>
      </tr>
    );
  }

  return (
    <tr className="border-b border-gray-100 align-top">
      <td className="py-2 pr-4">{user.employeeCode}</td>
      <td className="py-2 pr-4" colSpan={4}>
        <div className="flex flex-col gap-2">
          <input
            className="rounded border border-gray-300 px-2 py-1 text-sm"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
          />
          <label className="flex items-center gap-1 text-sm">
            <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
            Active
          </label>
          <RoleCheckboxes selected={roleKeys} onChange={setRoleKeys} />
          {tempPassword && (
            <p className="text-sm text-green-700">
              New temporary password: <span className="font-mono">{tempPassword}</span> (shown once — relay it to
              the user now)
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          )}
        </div>
      </td>
      <td className="flex gap-2 py-2">
        <button
          onClick={() => void save()}
          disabled={roleKeys.length === 0}
          className="text-sm text-blue-700 hover:underline disabled:opacity-50"
        >
          Save
        </button>
        <button onClick={() => setEditing(false)} className="text-sm text-gray-600 hover:underline">
          Cancel
        </button>
      </td>
    </tr>
  );
}

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
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold">Users</h1>

      {createdTempPassword && (
        <div className="rounded border border-green-300 bg-green-50 p-3 text-sm">
          Created <strong>{createdTempPassword.employeeCode}</strong> with temporary password{' '}
          <span className="font-mono">{createdTempPassword.password}</span> — shown once, relay it to the new hire
          now.
        </div>
      )}

      <NewUserForm onCreated={handleCreated} />

      {users === 'loading' && <p className="text-sm text-gray-500">Loading…</p>}
      {users === 'error' && <p role="alert">Could not load users.</p>}
      {Array.isArray(users) && (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-gray-500">
              <th className="py-2 pr-4 font-medium">Code</th>
              <th className="py-2 pr-4 font-medium">Name</th>
              <th className="py-2 pr-4 font-medium">Department</th>
              <th className="py-2 pr-4 font-medium">Roles</th>
              <th className="py-2 pr-4 font-medium">Status</th>
              <th className="py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <UserRowEditor key={user.id} user={user} onSaved={handleSaved} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
