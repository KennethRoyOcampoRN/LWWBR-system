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
import { RequirePermission } from './routes/RequirePermission.js';
import { ReportsPage } from './routes/ReportsPage.js';
import { RolesPage } from './routes/RolesPage.js';
import { SessionsPage } from './routes/SessionsPage.js';
import { ShiftsPage } from './routes/ShiftsPage.js';
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
                    path="/shifts"
                    element={
                      <RequirePermission permission="shift:read">
                        <ShiftsPage />
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
                  {/* Client decision, 2026-11-03 (spec.md §13, same
                      dormant-not-deleted shape as decision 9): Payment
                      Verification (/payment-verification) and
                      Quotations (/quotations) routes removed outright,
                      not left reachable by direct URL — not needed for
                      the initial rollout, and a half-hidden route with
                      no nav entry is worse than no route at all. The
                      page components (RemittancePage.tsx,
                      QuotationsPage.tsx) and the entire remittance and
                      quotation backend stay untouched, dormant. */}
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
