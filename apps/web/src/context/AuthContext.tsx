import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { PermissionKey, PermissionScope, RoleKey } from '@lwwbr/shared';
import { api, ApiRequestError } from '../lib/api.js';

export interface CurrentUser {
  id: string;
  employeeCode: string;
  fullName: string;
  email: string | null;
  department: string;
  mustChangePassword: boolean;
  roles: RoleKey[];
  permissions: Partial<Record<PermissionKey, PermissionScope>>;
}

interface AuthContextValue {
  user: CurrentUser | null;
  // undefined while the initial /auth/me check is still in flight — lets
  // the app show a loading state instead of flashing the login screen for
  // an already-authenticated user on refresh.
  loading: boolean;
  login: typeof loginImpl;
  logout: () => Promise<void>;
  // Re-fetches /auth/me — used after an action that changes the current
  // user's own record server-side without going through login() (e.g.
  // ChangePasswordPage clearing mustChangePassword).
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

async function loginImpl(employeeCode: string, password: string, totpCode?: string) {
  return api.post<{ user: CurrentUser } | { totpSetupRequired: true; provisioningUri: string }>('/auth/login', {
    employeeCode,
    password,
    ...(totpCode ? { totpCode } : {}),
  });
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchUser = useCallback(async () => {
    try {
      const res = await api.get<{ user: CurrentUser }>('/auth/me');
      setUser(res.user);
    } catch (err) {
      // 401 just means "not logged in" — every other error still leaves
      // the login screen as the fallback, so it's not re-thrown here.
      if (!(err instanceof ApiRequestError && err.status === 401)) {
        console.error(err);
      }
    }
  }, []);

  useEffect(() => {
    void fetchUser().finally(() => setLoading(false));
  }, [fetchUser]);

  const login = useCallback(async (employeeCode: string, password: string, totpCode?: string) => {
    const result = await loginImpl(employeeCode, password, totpCode);
    if ('user' in result) {
      setUser(result.user);
    }
    return result;
  }, []);

  const logout = useCallback(async () => {
    await api.post('/auth/logout');
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, refreshUser: fetchUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
