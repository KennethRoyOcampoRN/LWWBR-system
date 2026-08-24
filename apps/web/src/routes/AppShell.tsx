import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.js';
import { NotificationBell } from './NotificationBell.js';

// Spec §8.1: "Left/bottom nav is generated from the user's effective
// permissions." Each entry names the permission key that unlocks it —
// add a screen, add a row here, no separate role-based menu config to
// keep in sync.
const NAV_ITEMS: {
  to: string;
  label: string;
  permission?: 'user:read' | 'role:manage' | 'unit:read' | 'workorder:read';
}[] = [
  { to: '/', label: 'Command Center' },
  { to: '/units', label: 'Units', permission: 'unit:read' },
  // workorder:read is the floor every role holds (see rolePermissions.ts's
  // own comment: "everyone can create a ticket and 'My tasks' views need
  // to read at least your own") — this nav item is effectively always
  // visible, same as the pattern already established for it server-side.
  { to: '/work-orders', label: 'Work Orders', permission: 'workorder:read' },
  // "Bookings" nav item removed 2026-08-24 (redesign, client decision):
  // this app no longer creates or manages reservations — check-in is now
  // a quick-action on the Units page itself (see UnitsPage.tsx's
  // CheckInPanel), not a separate screen.
  { to: '/users', label: 'Users', permission: 'user:read' },
  { to: '/roles', label: 'Roles', permission: 'role:manage' },
  // Self-service account settings, not a permission-scoped resource —
  // GET /auth/sessions is already scoped server-side to the caller's own
  // rows, so every authenticated user gets this regardless of role.
  { to: '/sessions', label: 'Sessions' },
];

export function AppShell() {
  const { user, logout } = useAuth();

  const visibleItems = NAV_ITEMS.filter((item) => !item.permission || user?.permissions[item.permission]);

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <nav className="flex shrink-0 flex-row items-center gap-1 border-b border-gray-200 bg-white p-2 md:w-56 md:flex-col md:items-stretch md:border-b-0 md:border-r md:p-4">
        <div className="hidden items-center justify-between md:flex">
          <p className="px-2 pb-2 text-sm font-semibold text-gray-500">Lucky Waku-Waku</p>
          <NotificationBell />
        </div>
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
        <div className="ml-auto md:hidden">
          <NotificationBell />
        </div>
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
