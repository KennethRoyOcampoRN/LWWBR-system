import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.js';

// Spec §8.1: "Left/bottom nav is generated from the user's effective
// permissions." Each entry names the permission key that unlocks it —
// add a screen, add a row here, no separate role-based menu config to
// keep in sync.
const NAV_ITEMS: { to: string; label: string; permission?: 'user:read' | 'role:manage' }[] = [
  { to: '/', label: 'Command Center' },
  { to: '/users', label: 'Users', permission: 'user:read' },
  { to: '/roles', label: 'Roles', permission: 'role:manage' },
];

export function AppShell() {
  const { user, logout } = useAuth();

  const visibleItems = NAV_ITEMS.filter((item) => !item.permission || user?.permissions[item.permission]);

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <nav className="flex shrink-0 flex-row gap-1 border-b border-gray-200 bg-white p-2 md:w-56 md:flex-col md:border-b-0 md:border-r md:p-4">
        <p className="hidden px-2 pb-2 text-sm font-semibold text-gray-500 md:block">Lucky Waku-Waku</p>
        {visibleItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) =>
              `rounded px-3 py-2 text-sm font-medium ${isActive ? 'bg-blue-100 text-blue-800' : 'text-gray-700 hover:bg-gray-100'}`
            }
          >
            {item.label}
          </NavLink>
        ))}
        <div className="mt-auto hidden flex-col gap-1 pt-4 text-sm md:flex">
          <p className="px-2 text-gray-700">{user?.fullName}</p>
          <button onClick={() => void logout()} className="rounded px-2 py-1 text-left text-gray-500 hover:bg-gray-100">
            Sign out
          </button>
        </div>
      </nav>
      <main className="flex-1 p-4 md:p-6">
        <Outlet />
      </main>
    </div>
  );
}
