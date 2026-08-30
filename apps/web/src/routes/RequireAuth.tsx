import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { Skeleton } from '../components/Skeleton.js';
import { useAuth } from '../context/AuthContext.js';

export function RequireAuth() {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Skeleton className="h-6 w-32" />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <Outlet />;
}
