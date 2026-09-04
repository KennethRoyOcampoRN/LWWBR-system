import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { AuthProvider } from './context/AuthContext.js';
import { AmenitiesPage } from './routes/AmenitiesPage.js';
import { AppShell } from './routes/AppShell.js';
import { ChangePasswordPage } from './routes/ChangePasswordPage.js';
import { DashboardPage } from './routes/DashboardPage.js';
import { FnbPage } from './routes/FnbPage.js';
import { LoginPage } from './routes/LoginPage.js';
import { RequireAuth } from './routes/RequireAuth.js';
import { RequirePasswordChange } from './routes/RequirePasswordChange.js';
import { QuotationsPage } from './routes/QuotationsPage.js';
import { RemittancePage } from './routes/RemittancePage.js';
import { RequirePermission } from './routes/RequirePermission.js';
import { ReportsPage } from './routes/ReportsPage.js';
import { RolesPage } from './routes/RolesPage.js';
import { SessionsPage } from './routes/SessionsPage.js';
import { StockPage } from './routes/StockPage.js';
import { UnitsPage } from './routes/UnitsPage.js';
import { UsersPage } from './routes/UsersPage.js';
import { WorkOrdersPage } from './routes/WorkOrdersPage.js';

export function App() {
  return (
    <BrowserRouter>
      {/* Spec §11 M6: outermost, last-resort net — catches a crash
          anywhere, including AppShell's own nav or the login/change-
          password screens outside it. AppShell's own boundary around
          its <Outlet /> is what actually protects the 9 authenticated
          pages day to day (see AppShell.tsx); this one is a backstop,
          not the primary line of defense, so it has no resetKey — a
          crash this high up is rare enough that a manual reload is an
          acceptable ask. */}
      <ErrorBoundary>
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
                  <Route
                    path="/amenities"
                    element={
                      <RequirePermission permission="amenity:read">
                        <AmenitiesPage />
                      </RequirePermission>
                    }
                  />
                  <Route
                    path="/restaurant"
                    element={
                      <RequirePermission permission="fnb:read">
                        <FnbPage />
                      </RequirePermission>
                    }
                  />
                  <Route
                    path="/stock"
                    element={
                      <RequirePermission permission="stock:read">
                        <StockPage />
                      </RequirePermission>
                    }
                  />
                  <Route
                    path="/reports"
                    element={
                      <RequirePermission permission="report:view">
                        <ReportsPage />
                      </RequirePermission>
                    }
                  />
                  <Route
                    path="/payment-verification"
                    element={
                      <RequirePermission permission="remittance:read">
                        <RemittancePage />
                      </RequirePermission>
                    }
                  />
                  <Route
                    path="/quotations"
                    element={
                      <RequirePermission permission="quotation:read">
                        <QuotationsPage />
                      </RequirePermission>
                    }
                  />
                  <Route path="/sessions" element={<SessionsPage />} />
                </Route>
              </Route>
            </Route>
          </Routes>
        </AuthProvider>
      </ErrorBoundary>
    </BrowserRouter>
  );
}
