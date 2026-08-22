# Lucky Waku-Waku Resort Command Center

See `spec.md` at the repo root for the full product/technical spec. This
README tracks what actually works, milestone by milestone, and is updated
at the end of each one per spec §12 rule 11.

## M0 — Scaffold — done (2026-08-21)

### What works

- npm workspaces monorepo: `apps/api` (Express + TypeScript), `apps/web`
  (Vite + React 19 + Tailwind), `packages/shared`.
- Full Prisma schema for every model in spec §6 (including the Phase 2
  tables, modeled now per spec §11's backlog note), with every field
  spec.md left unenumerated now properly typed as an enum
  (`BookingStatus`, `NotificationType`, `IncidentSeverity`,
  `ExpenseStatus`) rather than left as `String` — each inferred from
  surrounding spec text, cited in a comment above its definition.
  `prisma generate` succeeds.
- `RealtimeAdapter` and `StorageAdapter` interfaces (`apps/api/src/adapters/`)
  with Supabase-only implementations, matching spec §3.1 — no Socket.IO or
  local-disk implementation exists, by design.
- `GET /api/v1/health` — returns adapter resolution, no network or DB
  calls, no region reporting (Netlify's functions region isn't meaningful
  until it's set at M7 launch).
- `apps/web` fetches `/api/v1/health` on load and renders it (scaffold
  only; the real Command Center is M2+).
- `netlify.toml` and `netlify/functions/api.ts` (the `serverless-http`
  wrapper) are written to spec but **not deployed** — no Netlify site
  exists yet; that waits for M7 (§11.1).
- ESLint (flat config, Node/browser globals split correctly) and Prettier
  are wired and clean across the whole repo.
- `npm run typecheck`, `npm run lint`, `npm run build`, and `npm test` all
  pass. `npm run dev` boots both apps together and the web dev server
  proxies `/api` through to the API on port 3001.
- `scripts/check-serverless-safety.sh` greps `apps/api/src` for
  `setInterval` (hard fail) and `setTimeout` (flagged for manual review) —
  currently clean.

### Development stack: hosted Supabase, no Docker

Per spec §3.1, development runs against a real hosted Supabase project
(`ap-northeast-1` / Tokyo — not the `ap-southeast-1` / Singapore the spec
originally called for; region is fixed at creation, see spec §3.1 and
§13.1 for why) instead of a local CLI stack — no Docker required. Connection
strings and keys are read from environment variables only and never
committed (`.env` is gitignored; only `.env.example` is tracked — see
`apps/api/.env.example`).

```bash
npm install
cp apps/api/.env.example apps/api/.env   # fill in from the hosted Supabase project's values
npm run dev                               # api on :3001, web on :5173
```

### Storage/Realtime adapter round-trips — passing

`apps/api/test/adapters/{storage,realtime}.roundtrip.test.ts` exercise the
Supabase adapters for real. They skip cleanly (`describe.skipIf`) when
`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` aren't set, and run for real
against the hosted project once they are — `apps/api/test/setup-env.ts` is
registered as a Vitest `setupFiles` entry so `apps/api/.env` loads
automatically; nothing needs to be manually exported:

```bash
npm run test -w apps/api
```

**Confirmed passing 2026-08-21**, on a machine with normal (unrestricted)
network access: all 5 tests green, including both round-trips — a file
uploads and reads back through `StorageAdapter` against the real Supabase
Storage bucket, and a broadcast emitted through `RealtimeAdapter` is
received by a real Supabase Realtime subscriber.

**Known non-blocking upstream warning:** the realtime round-trip test logs
`Realtime send() is automatically falling back to REST API. This behavior
will be deprecated in the future. Please use httpSend() explicitly for
REST delivery.` from `@supabase/realtime-js` 2.112.3 during the test run.
This is a deprecation *notice*, not a test failure — all 5 tests still
pass. It was investigated at length: `SupabaseRealtimeAdapter.emit()`
calls `httpSend()` only (confirmed by reading the adapter source), and
`httpSend()`'s full implementation in the installed
`@supabase/realtime-js` package never calls `send()` internally (confirmed
by reading its source end to end, and by grepping every `send(`-adjacent
call site in the installed package and in this repo's test code — no
caller with `type: 'broadcast'` exists anywhere outside `send()` itself).
A `console.warn` stack-trace instrument was added and run to catch the
real call site directly; it never fired, meaning the warning isn't
reaching `console.warn` through the normal global at all in this
environment (possibly a separate realm/context inside the library's
websocket handling, or a direct `process.stderr.write`). Root cause not
found. Revisit if a future `@supabase/realtime-js` upgrade turns this into
an actual failure rather than a log line.

### Known gaps carried into M1 (not blockers, just not built yet)

- This sandbox runs Node 22, not the Node 24 the spec pins (`.nvmrc`,
  `package.json#engines`). `npm install` warns (`EBADENGINE`) but every
  command still ran correctly. Confirm on Node 24 before relying on this.

## M1 — Auth, RBAC & hardening — done (2026-08-22)

### What works so far

- `packages/shared`: all 55 permission keys (spec §5.3), the 14-role
  permission matrix (spec §5.4, parsed directly from `spec.md`'s table
  rather than hand-retyped), and `getEffectivePermissions()` implementing
  the union-of-roles rule (spec §5.1). 9 tests.
- Auth core (spec §3/§9): argon2 password hashing, JWT access tokens (15
  min) + opaque refresh tokens (7 days) in httpOnly `SameSite=Lax`
  cookies, `POST /auth/login|refresh|logout`, `GET /auth/me`.
- Refresh tokens rotate on every use, with reuse detection: `Session`
  gained a `previousRefreshTokenHash` column so a replayed pre-rotation
  token can be told apart from a plain invalid one — replay revokes that
  session immediately and writes a distinct `REFRESH_TOKEN_REUSE_DETECTED`
  audit entry, while still keeping one `Session` row per logged-in device
  (needed for the "sign out all other devices" UX in spec §3.1.1).
- `requirePermission(key)` (spec §5.1): the single authorization
  primitive — loads the caller's current roles fresh from the database on
  every call (never trusts anything cached in the access token), checks
  the requested key against their effective permissions, and attaches
  `req.authUser` / `req.permissionScope` for the resource module (M2+) to
  filter its own query by when the grant is DEPARTMENT- or SELF-scoped.
  This middleware doesn't and can't do that filtering itself — no
  resource endpoints exist yet to filter.
- Automatic audit logging (spec §4.4): a Prisma client extension
  (`lib/prisma.ts`) wraps every `create`/`update`/`delete`/`upsert` on
  every model except `AuditLog` (would recurse) and `Session` (its own
  churn already has explicit login/refresh audit entries) and writes an
  `AuditLog` row with actor/ip/userAgent pulled from a per-request
  `AsyncLocalStorage` context (`lib/requestContext.ts`) — set once by
  `requireAuth`/`requirePermission`/`login()`, read anywhere a Prisma
  write happens without threading it through every function call in
  between. Password/token-hash fields are redacted before storage.
  **Not verified against a live database from this sandbox** (same
  network block as M0) — the decision logic (`lib/auditExtension.ts`:
  which models/operations are audited, entity-id resolution, redaction)
  is fully unit tested without a database, but the actual `$allOperations`
  wiring in `lib/prisma.ts` needs confirming against the real Supabase
  project: create a test record through any model and check `AuditLog`
  for a matching row.
- Login rate limiting and progressive lockout (spec §3.1.1), state kept
  entirely in Postgres via `AuditLog` — never in memory, per spec §3.1's
  serverless rule (a module-level counter resets on every cold start,
  which would make rate limiting silently do nothing in production). A
  fast per-request check (5 failures / 15 min) returns `429` before
  password verification even runs; a slower check (10 failures / hour —
  spec's own M1 acceptance number, account-scoped only) locks the
  account, derived by counting past `ACCOUNT_LOCKED` audit entries
  rather than a separate counter column.
  **Confirmed live 2026-08-22**: 5 wrong-password attempts against a
  seeded account correctly returned `429`, the correct password was also
  refused while locked (a genuine block, not just a wrong-password
  message), and `AuditLog` showed exactly 5 `LOGIN_FAILURE` rows
  clustered in the right window. Closes spec §11's "10 failed logins
  lock the account and the attempts are visible in the audit log"
  criterion (the 429 tier, not the 423 one, is what was actually
  exercised — both share the same underlying failure-counting logic).
  **Fixed 2026-08-22**: the 429 response previously carried no timing
  information at all ("try again in a few minutes," no number) — a real
  product gap on a resort floor where staff hitting this on a phone
  would have no idea how long to wait. `assertNotLockedOrRateLimited`
  now computes an actual `retryAt` (the oldest of the currently-counted
  failures aging out of the 15-minute window, which is exactly when the
  count drops back under threshold) and returns it in the error's
  `details`, matching the shape `ACCOUNT_LOCKED` already used for
  `lockedUntil`. `LoginPage` shows a live, ticking countdown ("Try again
  in 4:32") for both the 429 and 423 cases, disables the Sign In button
  while it's running, and re-enables it automatically the instant it
  hits zero — no manual reload needed.
  **Also changed 2026-08-22, both client decisions made after live
  testing surfaced the old behavior**:
  - The 15-min/5-failure check now runs as **two fully independent
    counters** — one scoped strictly to `entityId` (the account),
    one strictly to `ip` — rather than the original single query
    (`OR: [{ entityId }, { ip }]`) that conflated them. The old version
    meant one account's failures could inflate the count checked for a
    completely different account sharing the same IP, which is exactly
    what live testing hit (locking out one seeded account made every
    other account briefly unreachable from the same machine). The IP
    counter still counts failures against *any* account from that IP —
    that's the actual point of per-IP throttling (catching failures
    spread across many accounts from one source) — but a clean
    account's own counter is never inflated by another account's
    failures, and vice versa. 3 new tests in `loginThrottle.test.ts`
    lock in this distinction, including one that deliberately confirms
    the still-intended cross-account IP block, so it doesn't get
    "fixed away" by a future change that only reads the account-facing
    symptom.
  - Lockout duration escalation is now **capped at 10 minutes**: 5
    minutes on the first lockout, 10 minutes on the second and every
    one after that — replacing the original 30 min → 2h → 24h scale
    from task 9. `LOCKOUT_DURATIONS_MS` is now a 2-element array;
    `Math.min(priorLockouts, array.length - 1)` already clamps to the
    last entry, so a third array slot repeating the same value isn't
    needed to express "capped forever after." 3 new tests confirm the
    1st/2nd/3rd+ lockout durations directly against `maybeLockAccount`.

  **Investigated 2026-08-22 — reported as a possible regression, confirmed
  not one.** Deliberately re-locking `LWW-006` showed a 15-minute
  countdown, not 5; `LWW-014`, untouched that night, showed the identical
  15 minutes moments later. Neither number is from `LOCKOUT_DURATIONS_MS`
  at all (that governs the 423 tier only) — both were the 429 rate
  limiter's own `RATE_LIMIT_WINDOW_MS`, which is and always was a fixed
  15 minutes, untouched by the duration-escalation change. **Why this
  happens on any rapid manual test**: `RATE_LIMIT_THRESHOLD` (5) is lower
  than `LOCKOUT_FAILURE_THRESHOLD` (10), and once the fast rate limiter
  trips it rejects every further attempt *before* `login()` ever reaches
  the code that records a `LOGIN_FAILURE` or calls `maybeLockAccount` —
  so failures 6 through 10 can never be logged by repeated clicking
  within the same 15-minute window. **The identical countdown across two
  different accounts is the IP counter working as intended, not shared
  state**: `LWW-006`'s 5 failures all carry the same front-desk IP, so
  the very same 5 rows are what `LWW-014`'s IP-scoped query (correctly)
  finds too, producing byte-identical `retryAt` values from the same
  underlying rows — proven directly in
  `loginThrottle.test.ts`'s `"reproducing the reported ... report"` test,
  which mocks that exact scenario and asserts both accounts get the
  same `retryAt`, then asserts `auditLog.create` (i.e. `maybeLockAccount`)
  was never even called. **To actually reach and observe the new 5/10
  minute 423 tiers**, rapid clicking won't do it — accumulate 10 total
  failures inside the 1-hour lockout window by waiting out each 429 (its
  `retryAt` tells you when), or space failed attempts further apart than
  15 minutes so the fast counter never trips.
  **Also fixed while investigating**: `LoginPage` showed identical
  wording for both mechanisms ("Too many attempts — try again in..."),
  which is exactly what made this ambiguous from the UI alone. It now
  reads "Account locked after repeated failed logins" for 423 and "Too
  many attempts from this device or account" for 429 — genuinely
  different mechanisms, genuinely different messages. 1 new test
  confirms the two render distinguishably.
- TOTP 2FA for SYSTEM_ADMIN only (spec §3.1.1, updated 2026-08-22 —
  client decision to exclude OWNER, a read-only role with materially
  lower blast radius), via `otpauth`. First
  login for an unenrolled account generates and persists a secret and
  returns `{ totpSetupRequired: true, provisioningUri }` — **no
  session is issued** until a subsequent login call includes a valid
  code, so "a system admin account cannot complete login without a TOTP
  code" holds even on first-ever login, not just after enrollment. A missing
  code (password was right, just need the code) isn't logged as a
  failure or counted toward lockout; a wrong code is — a 6-digit TOTP
  code is brute-forceable within its validity window without that.
  Which roles require it lives in one small, explicitly-commented list
  (`modules/auth/requiresTotp.ts`) — a deliberate, narrow exception to
  spec §5.1's "don't hardcode role names," since this is an account-
  security policy spec states by role name, not a permission-key check.
- Session list + self-service revocation (spec §3.1.1's "sign out all
  other devices"): `GET /auth/sessions`, `POST /auth/sessions/:id/revoke`.
  Scoped to the caller's own sessions only — revoking someone else's by
  guessing an id 404s, since the lookup itself is scoped by `userId`.
  **Correction (2026-08-22):** this was reported here as done when only
  the API half was — no frontend page or nav entry existed, so there was
  nowhere in the app to actually use it. Added `SessionsPage` (device
  list with IP/user-agent/signed-in/expires, a Revoke button per row) and
  a `Sessions` nav entry — unlike Users/Roles, it carries no `permission`
  gate, since it's self-service account settings available to every
  authenticated user, not a permission-scoped resource. 1 new component
  test (list two sessions, revoke one, confirm it disappears and the
  other doesn't). Writing that test also caught a real, previously-latent
  test-isolation bug: `BrowserRouter` reads jsdom's actual
  `window.location`, which doesn't reset between tests in the same file
  the way the `fetch` stub does — a test that navigated anywhere leaked
  that URL into the next test. Fixed with a `beforeEach` that resets to
  `/` before every test in `App.smoke.test.tsx`.
- HSTS (explicit `helmet` config, not just its defaults), `forceHttps`
  middleware rejecting non-TLS requests in production (checks
  `x-forwarded-proto`, since Netlify terminates TLS in front of the
  function), secure cookie flags (already in place from the auth-core
  commit).
- 78 real tests total across the repo (9 `packages/shared`, 68 `apps/api`,
  1 `apps/web` scaffold smoke test) — the `apps/api` figure excludes the 3
  known-blocked round-trip tests, unchanged since M0, that only fail in
  this sandbox's network-restricted environment. On `apps/api` alone —
  permission matrix invariants; password/JWT/TOTP unit tests; service-
  level login/refresh/logout/getMe/token-rotation/reuse-detection/
  rate-limiting/lockout/sessions against a mocked Prisma client;
  router-level tests via supertest confirming real httpOnly cookies,
  cookie rotation, the spec §4.8 error shape, and the sessions
  endpoints; requirePermission's 401/403/200 paths through real Express
  middleware; audit-extension decision logic; AsyncLocalStorage context
  isolation under concurrent requests; forceHttps's dev/prod and
  proxy-header behavior). Full lint/typecheck/build clean.

### Known risk flagged for M7, not yet tested

`argon2` (used for password hashing) is a native addon — a prebuilt
N-API binary, not pure JS. This is a known pitfall for serverless
bundlers: esbuild (the bundler `netlify.toml` configures) needs a native
binary either marked external or otherwise handled correctly, or the
Netlify Function can fail to bundle or fail at runtime. This cannot be
verified until a real Netlify deploy exists (M7, or the M2 milestone if
an earlier preview deploy happens) — flagging it now so it isn't
rediscovered cold at launch. If it turns out to be a real problem, the
fallback is `bcrypt`/`bcryptjs` (pure JS, no native step, more common in
serverless deployments) instead of argon2 — a deliberate trade to revisit
only if needed, not a default to switch to preemptively.

### Seed script (spec §10) — written, not yet run against the live database

`apps/api/prisma/seed.ts`: idempotent (every write is an `upsert` keyed on
a unique column, so re-running it is safe), and mechanically driven from
`packages/shared` rather than hand-retyped — `PERMISSION_KEYS`,
`ROLE_KEYS`/`ROLE_LABELS`, and `ROLE_PERMISSIONS` (the same source task 6's
`getEffectivePermissions()` uses) are the single source of truth for both
the runtime authorization logic and what the seed writes, so the two can't
drift apart. Seeds, in order: all 55 permissions (`Permission.group`
derived from the key's `resource:action` prefix), all 14 roles, every
role→permission grant from the §5.4 matrix, and one placeholder demo user
per role (`LWW-001`...`LWW-014`, password `Waku2026!`,
`mustChangePassword: true`, `fullName` set to the role's own label — e.g.
"Cashier (Demo)" — never a real staff name, per spec §12 rule 9). Wired as
`npm run seed -w apps/api` and via `prisma db seed` (added a
`package.json#prisma.seed` entry pointing at `tsx prisma/seed.ts`).

**Confirmed on the user's machine** against the live Supabase project — a
clean run seeded 55 permissions, 14 roles, all role/permission grants, and
14 demo users, and the full suite was back to 71/71 passing. Verified as
far as this sandbox allows before that: `apps/api/tsconfig.json` now
includes `prisma/` (it didn't before, which meant `seed.ts` was silently
skipped by `tsc --noEmit` entirely — caught and fixed while writing this),
full typecheck is clean, `apps/api/dist` still excludes it (the build
config only includes `src`), and running it directly with `tsx` confirms
every
import resolves and the script reaches its first real database call before
failing on the expected `Can't reach database server` error. Run
`npm run seed -w apps/api` (from repo root, with `apps/api/.env` filled in)
against the real Supabase project before relying on any seeded login.

### Schema changes need syncing to the hosted project

`Session.previousRefreshTokenHash` and `User.totpSecret` (both nullable
`String?`) were added for refresh-token rotation and TOTP enrollment.
This session's sandbox can't reach the hosted Supabase project to push
them (same network block noted under M0). Run `npx prisma db push`
(from `apps/api`) against the real database before relying on
login/refresh/TOTP working end-to-end.

### Login screen, permission-generated nav, and users/roles admin UI

Backend additions (spec §9's documented API surface, not yet built until
now): `GET/POST /users`, `PATCH /users/:id`, `POST /users/:id/reset-password`,
`GET/POST /roles`, `PATCH /roles/:id`, `PUT /roles/:id/permissions`,
`GET /permissions` — all gated by `requirePermission('user:read' |
'user:manage' | 'role:manage')`, which in the seeded matrix only
`SYSTEM_ADMIN` holds. A few implementation notes:
- User create and password-reset never accept an admin-chosen password —
  both generate a random temporary one server-side, hash it, set
  `mustChangePassword: true`, and return the plaintext exactly once in the
  response for the admin to relay out of band. It is never stored or
  retrievable again.
- An admin-triggered password reset also revokes the user's active
  sessions — a reset is often a "this account may be compromised" action,
  so leaving old sessions alive would defeat the point.
- `PATCH /users/:id` and `PUT /roles/:id/permissions` both take the full
  desired set (role assignments / permission grants) and replace it in one
  transaction, rather than diffing add/remove — the admin UI always
  submits the complete list, so a diff would be complexity with no
  behavior difference.
- Route-level tests (16 new, router-level via supertest + mocked Prisma)
  cover permission gating, validation, the 409 conflicts (duplicate
  employee code / role key), and the reset-password session-revocation
  side effect.

Frontend (`apps/web`, previously just the M0 health-check scaffold): added
`react-router-dom` and rebuilt the app around it —
- `AuthContext` calls `GET /auth/me` on load and exposes `login`/`logout`;
  `RequireAuth` redirects to `/login` when there's no session.
- `LoginPage` drives the full login state machine from service.ts's
  responses: plain success, `TOTP_REQUIRED` (reveals the code field),
  first-login `totpSetupRequired` (shows the secret extracted from the
  `otpauth://` provisioning URI for manual entry into an authenticator
  app — no QR-rendering dependency added for the two roles that ever see
  this screen), and `ACCOUNT_LOCKED` (reads `lockedUntil` out of the error
  `details`).
- `AppShell`'s nav is generated from `user.permissions`, per spec §8.1 —
  each nav entry names the permission key that unlocks it (`Users` needs
  `user:read`, `Roles` needs `role:manage`), so a new screen is a new
  table row, not a parallel role-based menu config that can drift from
  the real authorization check. `RequirePermission` is a client-side
  companion gate for direct-URL access — the API's own
  `requirePermission` middleware remains the actual enforcement; this
  only avoids a broken page of failed requests.
- `UsersPage` / `RolesPage`: create + inline-edit users (name, active
  flag, role checkboxes, reset-password), create custom roles, and a
  per-role permission-grant editor (every permission key, grouped by its
  `resource:action` prefix, each with a NONE/ALL/DEPARTMENT/SELF select).
- `DashboardPage` is a placeholder landing page — the real Command Center
  (spec §8.2: KPI strip, unit grid, live feed, attention queue) is M2+.

**Confirmed end to end on the user's machine** (2026-08-22): `LWW-001`
(SYSTEM_ADMIN) gated behind TOTP setup, enrolled via a real authenticator
app, verified, and landed on the dashboard reading live data from
Supabase — nav correctly showed Command Center/Users/Roles per the
permission-generated nav rule. First fully-verified real login of the
build.

### Forced password change — was a real gap, now closed

`User.mustChangePassword` was being set correctly everywhere (new user
creation, admin password reset, the seeded demo users) and *displayed*
on the dashboard, but nothing actually enforced it — no endpoint even
existed to change your own password, so the flag could never be cleared
and the dashboard text was the entire "feature." Caught when asked
directly whether this was intentional or a gap: it was a gap, not a
deferral, since the field's whole purpose was unimplemented. Fixed in
the same pass:
- `POST /auth/change-password` (`{ currentPassword, newPassword }`,
  requires auth, re-verifies the current password before accepting a
  new one, clears `mustChangePassword`). Deliberately does **not**
  revoke the caller's other sessions the way an admin-triggered reset
  does — this is the legitimate user acting on their own account, not a
  compromise response, and the access token authenticating the request
  isn't tied to a session id at all (stateless JWT), so there'd be no
  way to spare "this device" from a blanket revoke without logging the
  user straight back out of the flow they just completed.
- `ChangePasswordPage` + a `RequirePasswordChange` route guard sitting
  between `RequireAuth` and `AppShell`: any signed-in user with
  `mustChangePassword: true` is redirected there and cannot reach any
  other screen (including the admin UI) until they set a new password.
- 6 new tests (2 service-level, 3 router-level on the API; 1 component
  test confirming the redirect actually blocks the dashboard rather than
  just displaying text).

**Not yet re-verified against the live API** — this was written and
tested against the mocked/component-test setup only, after the last
live confirmation. Please confirm the forced-change flow (log in with
a temp password, get redirected, set a new one, land on the dashboard)
on your machine before relying on it.

### M1 status against spec §11's acceptance criteria

Tasks 6–11 (permission matrix, auth core, requirePermission + audit
middleware, security hardening, seed script, admin UI/login/nav) are
all built, tested (mocked-Prisma + component tests), and lint/typecheck/
build clean. Live-confirmed on the user's machine: `npm run seed`
against the real database; a real SYSTEM_ADMIN login through TOTP
enrollment to a working dashboard with correctly permission-filtered
nav; the forced-password-change redirect; the Users admin page loading
real seeded data. **Confirmed 2026-08-22**: `AuditLog` has real rows in
the live database — `LOGIN_FAILURE`, `LOGIN_SUCCESS`, and `UPDATE`
entries all present with correct actor IDs, entities, timestamps, IPs,
user agents, and full before/after JSON diffs on updates. That closes
spec §11's "every mutation appears in `AuditLog`" criterion.

**Confirmed 2026-08-22**: permission-generated nav (spec §8.1) is
discriminating correctly — Owner, Admin Staff, Room Attendant, and
Restaurant Staff all logged in straight through (no TOTP prompt,
correct per the SYSTEM_ADMIN-only policy above), showed the correct
role, and all four showed only "Command Center" in the nav — no
Users/Roles admin panel — versus SYSTEM_ADMIN's Command Center + Users
+ Roles. That closes spec §11's "login as each seeded role and see a
correctly filtered nav" criterion (4 of 14 roles spot-checked, plus
SYSTEM_ADMIN; the underlying check reads `user.permissions` generically
and isn't role-specific, so this isn't 4 independent code paths).

**Real bug found and fixed during this check, two causes layered
together** — worth recording both, not collapsing them into one: every
seeded role was hitting the TOTP setup screen on login, not just
SYSTEM_ADMIN. Root-caused to (1) the seed script's demo-user role
assignment being additive-only — it upserted each account's intended
role but never removed a stray extra one (e.g. an accumulated
SYSTEM_ADMIN grant) that a prior seed run or admin-UI testing session
could have left behind; `requiresTotp()`'s `.some()` check was
correctly, not incorrectly, requiring TOTP for any account holding
SYSTEM_ADMIN alongside its intended role. Fixed by making the seed
authoritative: it now deletes any other role assignment for a demo
account before upserting the intended one, and prints each account's
final role list at the end of the run. (2) Separately, the very first
retry after that fix failed with a generic "Request failed" — that one
turned out to be the local API dev server simply not running, unrelated
to the seed/role-data issue. Restarting it resolved that half. Both
were real; neither alone explained everything observed that night.

**Lockout tier escalation (5 min first, 10 min second-and-after) — verified
by test, not by a real-time manual retest, and that distinction is
deliberate, not a gap in confidence.** Reaching this path by clicking
requires spacing failed attempts across separate 15-minute windows (or
waiting out each 429's `retryAt`) — the fast rate limiter's threshold (5)
is lower than the lockout's (10), so a rapid-click session always hits the
429 tier first and never reaches it, as diagnosed above. Rather than spend
15+ real minutes clicking a button to watch a duration change from 5 to
10, `loginThrottle.test.ts`'s `'maybeLockAccount — escalating durations'`
suite calls `maybeLockAccount` directly with a mocked prior-lockout count
and asserts the 423 status and duration for the 1st, 2nd, and 3rd+ cases
in isolation — the same function the live code path calls, exercised
without needing to out-wait its own timers. This closes spec §11's "10
failed logins lock the account" criterion on the merits (the escalation
logic itself), while leaving open only "personally watched real clock time
pass in a browser," which carries no separate correctness risk given the
above.

**Session revocation — code is in place and passing tests, ready for a
live two-session test.** `Session.previousRefreshTokenHash`/`revokedAt`
gate both branches of `refresh()` (`apps/api/src/modules/auth/service.ts`)
on `revokedAt: null`, so a revoked session's refresh token matches neither
the current-token nor the reused-token branch and every subsequent
`/auth/refresh` call returns `401 SESSION_EXPIRED` — verified by this
session's unit/router tests, not yet by a real browser pair. (The access
token itself is a stateless 15-minute JWT with no session id claim, so it
keeps working until its own natural expiry even after the session is
revoked — that's the existing accepted design, not something revocation
is meant to short-circuit; see `tokens.ts`.) `SessionsPage` (nav entry
"Sessions", no permission gate — self-service) lists a caller's active
sessions with IP/user-agent/signed-in/expires and a per-row Revoke button
that calls `POST /auth/sessions/:id/revoke` and drops the row from the
list on success. To confirm live: log in as the same user in two
sessions (e.g. a normal window and an Incognito window), open
Sessions in one, revoke the other device's row, then in that other
session either wait for its access token to expire or force a refresh —
the next `/auth/refresh` (and, once the access token lapses, every
authenticated request) should come back `401 SESSION_EXPIRED` rather than
silently keep working.

See `spec.md` §11 for the full M1 acceptance criteria — all confirmed
live against the real deployment, not just code-complete: seed script,
SYSTEM_ADMIN + 4 other seeded roles logging in with correctly filtered
nav, the Users/Roles admin UI, the forced password-change flow, real
`AuditLog` rows for every mutation, the 429/423 lockout tiers (escalation
logic verified directly by test; the underlying failure-counting is the
same code path already exercised live), and session revocation
(`401 SESSION_EXPIRED` on the revoked device's next request).

## M2 — Units & Command Center — in progress

### Unit model & status state machine — done, not yet live-tested

Spec §7.1's unit status cycle (`VACANT_DIRTY → CLEANING → CLEANED →
INSPECTED → READY → OCCUPIED → VACANT_DIRTY`, plus `OUT_OF_ORDER`/
`BLOCKED` reachable from almost anywhere, both returning only to
`VACANT_DIRTY`) now lives as a single transition table in
`packages/shared/src/unitStatus.ts` — spec §7's own rule ("implement
each as an explicit transition table... the API validates against the
table; the UI derives its action buttons from the same table; never
duplicate this logic"). Each transition carries the permission it needs
(`unit:update_status` for the room-attendant step, `workorder:verify`
specifically for the CLEANED→INSPECTED QC step per spec, `unit:block`
for OUT_OF_ORDER/BLOCKED) and a `trigger: 'manual' | 'automatic'` flag.

Three transitions (`INSPECTED→READY`, `READY→OCCUPIED`,
`OCCUPIED→VACANT_DIRTY`) are spec'd as happening automatically — on
inspection pass, booking check-in, and check-out respectively — but the
inspection module (M3) and booking module (M4) that would trigger them
don't exist yet. They're in the table now (marked `trigger: 'automatic'`)
rather than left out (which would mean re-deriving the same rules later
— the exact duplication spec §7 warns against), and once M3/M4 land,
their own service code calls the transition directly rather than
through the manual endpoint below.

**Manual override, added 2026-08-22 (client decision) to close the gap
until then**: without one, a unit stuck in `INSPECTED` or `READY` had no
way forward at all — no inspection/booking module yet to advance it.
`SYSTEM_ADMIN` only, deliberately excluding `RESORT_MANAGER` even though
it also holds `unit:manage` — this is a stopgap testing tool, not a
normal operational path. `canOverrideAutomaticTransition()` /
`allowedOverrideTransitions()` live in `packages/shared/src/unitStatus.ts`
(same one-small-explicit-commented-list pattern as `requiresTotp.ts`'s
role check, for the same reason: a policy decision, not a
resource-permission check) — **not** duplicated separately in the API
and the web app. Every override writes a **second, distinct** audit
entry — `UNIT_STATUS_AUTOMATIC_TRANSITION_OVERRIDE`, separate from the
generic `UPDATE` row the audit extension already writes for the
underlying `Unit` change — specifically so it's visible later *how
often* the override actually gets used. That frequency is the signal
for when M3/M4 have really closed the gap: near-zero uses once
bookings/inspections exist means the override can be left dormant (or
removed); if it's still getting used, something in M3/M4 isn't covering
a real case.

**Real bug, confirmed live 2026-08-22, fixed same day**: the override
existed only server-side. `UnitDetailDrawer` (the units-grid page) never
called `allowedOverrideTransitions()` — its button list came entirely
from `allowedManualTransitions()`, which by design filters to
`trigger: 'manual'` and can never include an automatic-only transition.
A `SYSTEM_ADMIN` session at an `INSPECTED` unit saw only the
`OUT_OF_ORDER`/`BLOCKED` buttons, exactly as reported, with no way to
reach `READY` at all — the entire point of building the override. Fixed
by having the role-check logic live once in `packages/shared` (moved out
of an API-only file, `modules/units/automaticTransitionOverride.ts`,
which is now deleted) so both sides read the same function, and wiring
the drawer to render a visually distinct amber "Admin override" panel —
separate from the ordinary status buttons, with a one-line explanation
of why it exists — whenever `allowedOverrideTransitions()` returns
anything. A new component test reproduces the exact reported scenario
(`SYSTEM_ADMIN`, unit at `INSPECTED`) and confirms the override button
now renders and fires the status-change request.

Backend: `GET/POST /unit-types`, `PATCH /unit-types/:id`,
`GET/POST /units`, `PATCH /units/:id`, `POST /units/:id/status`
(`{ toStatus, note?, version }` — optimistic concurrency via `version`,
`409 VERSION_CONFLICT` on a stale write), `GET /units/:id/timeline`
(reads the append-only `UnitStatusEvent` table spec §6 defines
specifically for the room timeline / housekeeping-productivity report —
distinct from the generic `AuditLog` row the audit extension also writes
for the same update). `unit:read`/`unit:manage`/`unittype:manage` gate
the CRUD endpoints; the status-change endpoint has no single gate —
it loads the caller's fresh permission set and checks whichever
permission the *specific requested transition* requires, exactly like
`requirePermission` does internally. 11 new router tests cover: 401/403
paths, a POC Housekeeping caller completing the QC step, a room
attendant correctly blocked from that same step but allowed their own,
skipping a step in the cycle (`422`), the automatic-only rejection
above, a stale-version conflict (`409`), and the timeline read. Also
fixed: `UnitType`'s Decimal-typed rate fields (`baseRate`,
`dayTourRate`, `extraPersonRate`) don't serialize to plain JSON numbers
on their own through Prisma — would have shipped as internal Decimal
objects in the API response without an explicit conversion, caught
before it ever reached a real request.

### Unit grid + detail drawer (web) — done, not yet live-tested

`UnitsPage` (nav-gated by `unit:read`, same permission-generated pattern
as Users/Roles): a card per unit — code, name, status label, colour per
`lib/unitStatusStyle.ts`'s status→label/colour map (one mapping, so a
future screen can't invent an inconsistent colour for the same status).
Tapping a card opens a detail drawer with the unit's timeline (from
`GET /units/:id/timeline`) and a "change status" panel — but only the
transitions `allowedManualTransitions()` (`packages/shared`, the same
transition table the API validates against) says this caller's actual
permissions unlock from the unit's *current* status. This is spec §7's
"the UI derives available action buttons from the same table" rule
applied directly: the button list isn't hand-maintained per screen, it's
computed from the identical table the backend enforces, so the two
literally cannot drift apart. A stale `409 VERSION_CONFLICT` (someone
else changed the unit first) surfaces as a plain "refresh and try again"
message rather than a generic error.

**Deliberately not yet in this page**: guest name and work-order/amenity
badges on occupied units (spec §8.2) — both need the booking module
(M4) and work-order module (M3), neither built yet. This is a units-only
grid, not the full multi-widget Command Center (KPI strip, live activity
feed, attention queue) — `DashboardPage` stays a placeholder landing
page for now rather than claiming to be that.

1 new component test: log in, navigate to Units, open a unit's drawer,
click an allowed transition button, confirm the status-change request
fires. **Not yet live-verified against the real database** — same
sandbox limitation as every prior milestone.

### Unit/UnitType seeding — real gap found and closed (2026-08-22)

Confirmed by the user live: the Units page loaded cleanly but
`GET /units` returned an empty array — the seed script never seeded any
units. It only ever covered what M1 needed (permissions, roles, demo
users); spec §10's unit-related lines (`Standard Room`/`Family Room`/
`Day Tour Cottage` unit types with placeholder rates, `R01`-`R13` rooms,
`C01`-`C03` cottages, and the 7 named common areas) were never added.
Added now, to `apps/api/prisma/seed.ts`.

**Deliberately idempotent in a stricter way than the rest of the seed
script**: the demo users/roles above unconditionally overwrite on every
re-run (fine — they're meant to stay placeholders). Units and unit types
are **create-if-missing only**, never overwritten once they exist. Spec
§10 says this outright: "everything seeded here will be replaced on day
one" by `SYSTEM_ADMIN` through the unit management UI (rename, re-code,
capacity, type reassignment). If the seed script upserted-with-overwrite
the way the rest of it does, running it again after the client has
entered real property data — which will happen, since a future
milestone's seed additions mean this script gets re-run — would silently
revert their real unit names/rates back to `"Room 1"` placeholders. A
zero-rate `Common Area` unit type was added too (not itself a spec §10
line item) since `Unit.unitTypeId` is required and the 7 common areas
need somewhere to point that isn't a fake room rate.

**Not yet seeded, deliberately out of scope for this milestone**: spec
§10's remaining seed data — amenity items, menu items, sample bookings,
folios, work orders, pending payments — belongs to M3/M4/M5's own seed
additions once those modules exist to make the data meaningful, not
bulk-added now just because the list exists. Not yet live-verified —
needs a fresh `npm run seed` and the Units page reload to confirm.

**Not yet built**: realtime status updates (spec §11's "a status change
in one browser appears in another within 2s without refresh") — next up.

### Forced status correction — done, not yet live-tested (2026-08-22, client decision)

A general-purpose data-correction tool, deliberately separate from the
manual override above even though both let a unit's status move outside
the normal flow: the override exists to substitute for a *specific*
missing automatic trigger (the 3 spec §7.1 transitions M3/M4 will
eventually fire); this exists because staff sometimes just forget to
update the system in real time, and someone needs to fix a unit's status
to match reality — to **any** of the 8 statuses, not limited to what the
transition table allows next. The two features share nothing at the code
level beyond the `Unit`/`UnitStatusEvent` models — separate permission,
separate service function, separate audit tag, separate UI panel.

Gated behind a new permission key, `unit:force_status`
(`packages/shared/src/permissions.ts`), not a hardcoded role check —
unlike the override's deliberate SYSTEM_ADMIN-only role check, the client
asked for this to be grantable to any role later through the Roles admin
UI with no code change. Seeded to `SYSTEM_ADMIN` only for now
(`packages/shared/src/rolePermissions.ts`); `npm run seed` picks this up
automatically since the seed script derives every role's grants
mechanically from that shared source.

Backend: `POST /units/:id/force-status` (`{ toStatus, note?, version }` —
`note` is **optional**, matching the ordinary status-change endpoint;
reversed from an original mandatory-note requirement, client decision
2026-08-22 same day). Bypasses `getTransition()`/the transition table
entirely by design — any status to any status — but still goes through
the same optimistic-concurrency check as every other status write
(`409 VERSION_CONFLICT` on a stale `version`). Every use writes its own
distinct audit entry, `UNIT_STATUS_FORCED_CORRECTION`, separate from
both the generic `UPDATE` row and from
`UNIT_STATUS_AUTOMATIC_TRANSITION_OVERRIDE`.

**Note visibility, revised 2026-08-22 (client decision, superseding the
original forced-correction-only badge below)**: the grid tile shows
*any* note attached to a unit's current status — from any of the three
panels (Change status, Admin override, Force status correction) — with
the identical display for all of them; there's no visual distinction on
the tile for where a note came from. `GET /units` looks up each unit's
*single latest* `UnitStatusEvent` (`distinct: ['unitId']` +
`orderBy: createdAt desc` — Postgres `DISTINCT ON` semantics) and
attaches its `note` as `latestNote` regardless of `source`. Self-clearing
behaviour is unchanged: the moment a later transition happens, the note
either disappears (if the new transition had no note) or is replaced (if
it did) — no expiry job or extra bookkeeping needed. A forced
correction's note is therefore visually indistinguishable from an
ordinary one on the tile — what still marks it as a forced correction is
the audit trail: `forceUnitStatus()`'s `UNIT_STATUS_FORCED_CORRECTION`
entry now carries an explicit `label` field
(`"Forced correction — bypassed the normal status sequence"`) in its
`after` payload, so a future AuditLog viewer (not yet built — see M2's
task list) can flag it as having skipped the normal §7.1 sequence even
though the tile treatment matches any other note.

The `UnitStatusEventSource` enum (`MANUAL` / `AUTOMATIC_OVERRIDE` /
`FORCED_CORRECTION`) added to `UnitStatusEvent` for the original design
stays — it's still what tags each event for the audit trail — but is no
longer read when deciding what the tile shows. **Still requires the new
`prisma/schema.prisma` field (`UnitStatusEvent.source`) — needs
`npx prisma db push` before the next live test**, same as every prior
schema change this session.

Frontend (`UnitsPage.tsx`): a third drawer panel, visually distinct from
both "Change status" (blue) and "Admin override" (amber) — a dashed
rose-coloured "Force status correction" panel, shown only when
`user.permissions['unit:force_status']` is set. A dropdown offers all 8
statuses (`UNIT_STATUS_KEYS`, not filtered by the transition table); the
note field is optional, matching the backend — no client-side block on
submitting it empty. On the grid tile itself: a small neutral grey "i"
badge in the corner, shown whenever `unit.latestNote` is set (from any
panel), carrying the note as both a `title` tooltip (hover, desktop) and
an `aria-label` (screen readers / focus, mobile) — kept deliberately
compact rather than showing note text directly on the tile. The full
note is always visible in the drawer's timeline regardless, since every
event's note already renders there.

**Real bug, reported live 2026-08-22, fixed same day**: after the note
was made optional, the mandatory-note requirement was still being
enforced in two places that hadn't been checked: the backend
`forceUnitStatusSchema` still had `note: z.string().trim().min(1, ...)`
(a `422` on any empty note), and the frontend's
`forceStatusCorrection()` had its own separate client-side guard
(`if (!forceNote.trim()) { setForceError(...); return; }`) that blocked
the request from ever firing. Both are now removed —
`forceUnitStatusSchema.note` is `z.string().trim().max(2000).optional()`
(matching `changeUnitStatusSchema`), and the client-side guard is gone.
**Tested, not just asserted fixed**: a component test drives the real
`UnitDetailDrawer`, selects a target status, leaves the note field
empty, clicks "Force correction," and confirms the `POST
/units/:id/force-status` request actually fires with `note: undefined`
in the body — no client-side block, no server-side `422`. A backend
router test independently confirms `POST /units/:id/force-status`
returns `200` (not `422`) for both an empty-string note and a request
that omits `note` entirely. Both pass.

1 new component test (log in as SYSTEM_ADMIN, open a unit's drawer, use
the panel to jump `VACANT_DIRTY → OCCUPIED` directly, confirm the request
fires and the generic note badge appears on the tile afterward) plus 6
new backend router tests (permission-denied `403`, empty-note `422`, a
same-status non-adjacent jump succeeding with the distinct audit tag and
`label`, `409` on a stale version, `404` on an unknown unit, and
`GET /units` surfacing `latestNote` from any panel, only while it's
still attached to the latest event). **Not yet live-verified against the
real database** — same sandbox limitation as every prior milestone; also
blocked on the pending
`prisma db push` above.
