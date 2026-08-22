import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.js';

// Sits between RequireAuth and the real app shell — a user whose password
// is a temp one issued at creation or admin reset (User.mustChangePassword)
// can't reach any other screen until they set a new one. Without this, the
// dashboard's "you must change your password" text was just that: text,
// with nothing actually enforcing it.
export function RequirePasswordChange() {
  const { user } = useAuth();

  if (user?.mustChangePassword) {
    return <Navigate to="/change-password" replace />;
  }

  return <Outlet />;
}
