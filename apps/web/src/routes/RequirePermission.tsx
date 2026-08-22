import type { PermissionKey } from '@lwwbr/shared';
import type { ReactNode } from 'react';
import { useAuth } from '../context/AuthContext.js';

// A client-side gate only — the API's requirePermission middleware is the
// real enforcement (spec §5.1). This exists purely so a user without the
// permission sees a plain message instead of a broken page full of failed
// requests after following a stale link or typing a URL directly.
export function RequirePermission({ permission, children }: { permission: PermissionKey; children: ReactNode }) {
  const { user } = useAuth();

  if (!user?.permissions[permission]) {
    return (
      <div role="alert" className="text-sm text-gray-600">
        You don&apos;t have permission to view this page.
      </div>
    );
  }

  return <>{children}</>;
}
