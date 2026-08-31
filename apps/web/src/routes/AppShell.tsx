import { useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { ErrorBoundary } from '../components/ErrorBoundary.js';
import { InstallButton } from '../components/InstallButton.js';
import { useAuth } from '../context/AuthContext.js';
import { NotificationBell } from './NotificationBell.js';

// Spec §8.1: "Left/bottom nav is generated from the user's effective
// permissions." Each entry names the permission key that unlocks it —
// add a screen, add a row here, no separate role-based menu config to
// keep in sync.
const NAV_ITEMS: {
  to: string;
  label: string;
  permission?:
    | 'user:read'
    | 'role:manage'
    | 'unit:read'
    | 'workorder:read'
    | 'amenity:read'
    | 'fnb:read'
    | 'report:view'
    | 'remittance:read'
    | 'quotation:read';
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
  // M5, first slice (2026-08-24): the amenity catalogue only —
  // request/issue/return is a later slice. Per the role matrix, Restaurant
  // Manager/Staff hold no amenity:* key at all, so this item is invisible
  // to them, same as every permission-gated nav item.
  { to: '/amenities', label: 'Amenities', permission: 'amenity:read' },
  // M5, restaurant slice 1 (2026-08-24): the menu only — order creation
  // and the kitchen board are a later slice. Per the role matrix,
  // Maintenance/Housekeeping staff hold no fnb:* key at all.
  { to: '/restaurant', label: 'Restaurant', permission: 'fnb:read' },
  // M6, report builder (2026-08-25): starting with occupancy/unit status
  // history and work-order stats (spec §8.4 items 1 and 4) — the two
  // report builders with the most real data already behind them from
  // tonight's testing.
  { to: '/reports', label: 'Reports', permission: 'report:view' },
  // Client-directed feature, 2026-08-31: two standalone administrative
  // request-and-status modules — see the modules' own README entry for
  // why these are remittance:*/quotation:*, not payment:*/booking:*.
  { to: '/payment-verification', label: 'Payment Verification', permission: 'remittance:read' },
  { to: '/quotations', label: 'Quotations', permission: 'quotation:read' },
  { to: '/users', label: 'Users', permission: 'user:read' },
  { to: '/roles', label: 'Roles', permission: 'role:manage' },
  // Self-service account settings, not a permission-scoped resource —
  // GET /auth/sessions is already scoped server-side to the caller's own
  // rows, so every authenticated user gets this regardless of role.
  { to: '/sessions', label: 'Sessions' },
];

export function AppShell() {
  const { user, logout } = useAuth();
  const location = useLocation();
  // Mobile-only: the nav below md renders as a collapsed top bar with
  // this toggling a slide-down menu, rather than the wrapping horizontal
  // row of text links it used to be — see the file-level comment above
  // the <nav> for the real bug this replaced. Purely a CSS
  // (hidden/flex) toggle, never a conditional unmount, so every link
  // stays in the DOM at all times — this is what keeps every existing
  // "click the Units link" test working without first opening the menu;
  // Tailwind's responsive classes have no effect in jsdom anyway (no
  // real layout engine), only in an actual browser.
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const visibleItems = NAV_ITEMS.filter((item) => !item.permission || user?.permissions[item.permission]);

  function closeMobileNav() {
    setMobileNavOpen(false);
  }

  return (
    // Visual redesign pass, spec §11 M6 (client-directed, 2026-08-31) —
    // token proposal approved before this landed; see README for the
    // full token set. This background gradient and the nav below are
    // shared chrome, not Dashboard-specific, so the visual change here
    // is visible on every screen even though only Command Center's own
    // content got redesigned in this first pass — that's intentional
    // scope, not a half-finished rollout (flagged and approved ahead of
    // time, see README).
    <div className="flex min-h-screen flex-col bg-app-gradient md:flex-row">
      {/* Real bug found live-testing, 2026-08-31 (mobile pass, spec §11
          M6): on an actual phone viewport this used to render every nav
          item as one horizontal row of text links with no wrap control —
          tight enough that "Command Center" (the longest label) wrapped
          onto two lines. Below md, the brand/notification/install row
          collapses to a slim top bar with a hamburger toggle; the actual
          links (shared with desktop, same markup) render as a full-width
          vertical list when open, one item per line, same as desktop's
          always-visible sidebar. At md and up this is all just the
          plain always-visible left sidebar it always was. */}
      <nav className="flex shrink-0 flex-col bg-white shadow-card md:w-56">
        <div className="flex items-center justify-between gap-2 p-2 md:p-4 md:pb-2">
          <p className="px-2 text-sm font-semibold text-ink-secondary">Lucky Waku-Waku</p>
          <div className="flex items-center gap-2">
            <InstallButton />
            <NotificationBell />
            <button
              type="button"
              onClick={() => setMobileNavOpen((open) => !open)}
              aria-expanded={mobileNavOpen}
              aria-label={mobileNavOpen ? 'Close menu' : 'Open menu'}
              className="rounded-xl p-2 text-ink-secondary hover:bg-brand-50 md:hidden"
            >
              {mobileNavOpen ? (
                <span aria-hidden="true" className="block text-lg leading-none">
                  ✕
                </span>
              ) : (
                <span aria-hidden="true" className="block text-lg leading-none">
                  ☰
                </span>
              )}
            </button>
          </div>
        </div>

        <div
          className={`flex-col gap-1 px-2 pb-2 md:flex md:flex-1 md:px-4 md:pb-4 ${mobileNavOpen ? 'flex' : 'hidden md:flex'}`}
        >
          {visibleItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              onClick={closeMobileNav}
              className={({ isActive }) =>
                `rounded-xl px-3 py-2 text-sm font-medium transition-colors ${
                  isActive ? 'bg-brand-600 text-white shadow-card' : 'text-ink-secondary hover:bg-brand-50 hover:text-brand-700'
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
          <div className="mt-2 flex flex-col gap-1 border-t border-brand-100 pt-2 text-sm md:mt-auto md:border-t-0 md:pt-4">
            <p className="px-2 text-ink-secondary">{user?.fullName}</p>
            <button
              onClick={() => {
                closeMobileNav();
                void logout();
              }}
              className="rounded-xl px-2 py-1 text-left text-ink-muted hover:bg-brand-50 hover:text-brand-700"
            >
              Sign out
            </button>
          </div>
        </div>
      </nav>
      <main className="flex-1 p-4 md:p-8">
        {/* Spec §11 M6: the boundary that actually protects the 9
            authenticated pages day to day — a crash in any single page
            shows a real error screen here instead of white-screening
            the whole app, and the nav above stays usable throughout.
            resetKey={location.pathname} means navigating to a different
            page after a crash recovers automatically, no manual reload
            needed. */}
        <ErrorBoundary resetKey={location.pathname}>
          <Outlet />
        </ErrorBoundary>
      </main>
    </div>
  );
}
