import { useAuth } from '../context/AuthContext.js';

// The real Command Center (spec §8.2 — KPI strip, unit grid, live activity
// feed, attention queue) is M2+. This is a signed-in landing placeholder
// so the nav/login/admin work in M1 has somewhere to land after login.
export function DashboardPage() {
  const { user } = useAuth();

  return (
    <div className="flex flex-col gap-2">
      <h1 className="text-lg font-semibold">Welcome, {user?.fullName}</h1>
      <p className="text-sm text-gray-600">
        Roles: {user?.roles.join(', ')}
        {user?.mustChangePassword && ' — you must change your password.'}
      </p>
      <p className="text-sm text-gray-500">The Command Center dashboard lands in M2.</p>
    </div>
  );
}
