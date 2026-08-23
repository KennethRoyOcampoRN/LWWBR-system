import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext.js';
import { AppShell } from './routes/AppShell.js';
import { ChangePasswordPage } from './routes/ChangePasswordPage.js';
import { DashboardPage } from './routes/DashboardPage.js';
import { LoginPage } from './routes/LoginPage.js';
import { RequireAuth } from './routes/RequireAuth.js';
import { RequirePasswordChange } from './routes/RequirePasswordChange.js';
import { RequirePermission } from './routes/RequirePermission.js';
import { RolesPage } from './routes/RolesPage.js';
import { SessionsPage } from './routes/SessionsPage.js';
import { UnitsPage } from './routes/UnitsPage.js';
import { UsersPage } from './routes/UsersPage.js';
import { WorkOrdersPage } from './routes/WorkOrdersPage.js';

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route element={<RequireAuth />}>
            <Route path="/change-password" element={<ChangePasswordPage />} />
            <Route element={<RequirePasswordChange />}>
              <Route element={<AppShell />}>
                <Route index element={<DashboardPage />} />
                <Route
                  path="/units"
                  element={
                    <RequirePermission permission="unit:read">
                      <UnitsPage />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/work-orders"
                  element={
                    <RequirePermission permission="workorder:read">
                      <WorkOrdersPage />
                    </RequirePermission>
                  }
                />
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
                <Route path="/sessions" element={<SessionsPage />} />
              </Route>
            </Route>
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
