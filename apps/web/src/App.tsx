import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext.js';
import { AppShell } from './routes/AppShell.js';
import { DashboardPage } from './routes/DashboardPage.js';
import { LoginPage } from './routes/LoginPage.js';
import { RequireAuth } from './routes/RequireAuth.js';
import { RequirePermission } from './routes/RequirePermission.js';
import { RolesPage } from './routes/RolesPage.js';
import { UsersPage } from './routes/UsersPage.js';

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route element={<RequireAuth />}>
            <Route element={<AppShell />}>
              <Route index element={<DashboardPage />} />
              <Route
                path="/users"
                element={
                  <RequirePermission permission="user:read">
                    <UsersPage />
                  </RequirePermission>
                }
              />
              <Route
                path="/roles"
                element={
                  <RequirePermission permission="role:manage">
                    <RolesPage />
                  </RequirePermission>
                }
              />
            </Route>
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
