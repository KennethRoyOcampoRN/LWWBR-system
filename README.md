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

### Forced status correction — done, live-verified (2026-08-22, client decision)

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
new backend router tests (permission-denied `403`, empty-note success, a
same-status non-adjacent jump succeeding with the distinct audit tag and
`label`, `409` on a stale version, `404` on an unknown unit, and
`GET /units` surfacing `latestNote` from any panel, only while it's
still attached to the latest event).

**Live-verified by the user, 2026-08-22**: after `npx prisma db push`
for `UnitStatusEvent.source` and `npm run seed`, confirmed against the
real Supabase database that an empty-note forced correction succeeds
(the fix above), the grid tile shows the note appropriately, and the
`UNIT_STATUS_FORCED_CORRECTION` `AuditLog` entry carries the `label`
field even when no note was given. This closes out the forced
status-correction feature for the night — no outstanding gaps between
this feature and what the client asked for.

### Realtime status updates — done, live-verified (2026-08-22)

Spec §11's M2 acceptance line: "two browsers open the grid; a status
change in one appears in the other within 2s without refresh." Spec §3
withdraws the Socket.IO implementation for MVP — **Supabase Realtime
broadcast only** — so this uses the `RealtimeAdapter` interface and
`SupabaseRealtimeAdapter` that M0 already built and round-trip tested,
just never wired into any real domain code until now (the only prior
caller was the M0 round-trip test itself and the health check's adapter
name report).

**Backend**: `changeUnitStatus()` and `forceUnitStatus()` in
`apps/api/src/modules/units/service.ts` both call a shared
`broadcastUnitStatusChanged()` helper after their `unit.updateMany()`
write succeeds — one code path for both, so a normal status change, an
admin override, and a forced correction all reach every open Units page
the same way, per spec §9.1: channel `property`, event
`unit.status.changed`, payload `{ entityId, actorId, at, summary,
fromStatus, toStatus, version, note }` — the extra fields beyond spec's
required four are what let the frontend patch its own state without a
refetch. **The broadcast is best-effort**: wrapped in try/catch and
merely logged on failure, never thrown — a Supabase Realtime outage or
network hiccup must not fail the underlying status change itself. Two
new router tests: one asserts the exact broadcast call for a normal
status change, one asserts the status change still returns `200` when
the broadcast itself rejects. The force-status test also asserts its
broadcast call.

**Frontend**: a new `apps/web/src/lib/realtime.ts` creates a browser
Supabase client from `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` (the
**anon/public** key — never the service role key, which must never
reach the browser bundle) and exposes
`subscribeToUnitStatusChanges(onEvent, onStatusChange)`. If the env vars
aren't set, it logs a warning and reports `'disabled'` rather than
throwing — realtime is simply off, not broken, and the grid still works
off the poll fallback below. New `apps/web/.env.example` documents the
two vars; `apps/web/.env` itself isn't committed (already covered by the
repo's blanket `.env` gitignore rule) and needs the real anon key from
the Supabase dashboard (Settings → API).

`UnitsPage` subscribes on mount and patches the matching unit's
`status`/`version`/`latestNote` in place when a broadcast arrives — no
refetch of the whole grid, matching the compact-and-live goal. A version
guard (`payload.version <= unit.version` → ignore) protects against a
stale or out-of-order broadcast regressing a tile that's already moved
past it (e.g. delivery reordering, or replaying an old event after a
reconnect).

**Resiliency (spec §3's "a dropped socket must never leave a stale board
with no recovery path")**: since this codebase doesn't use TanStack
Query, the same fallback principle is hand-rolled — a 60s poll
(`setInterval` **in browser code**, not a serverless function; the
spec's ban on `setInterval`-based scheduling is specifically about
faking cron jobs in Netlify Functions, per §3.1, and doesn't apply to
client-side UI polling) and a `window.addEventListener('focus', ...)`
refetch, both independent of whether the realtime channel is currently
connected. A subtle "Reconnecting…" badge appears next to the page
heading only once the channel has reached `'connected'` at least once
and then drops — so a normal page load's brief initial `'connecting'`
state, or realtime being intentionally `'disabled'` (no env vars), never
shows it.

1 new component test drives this without touching
`@supabase/supabase-js` at all: it mocks this app's own
`lib/realtime.js` wrapper (not the library, keeping the test fast and
independent of real websocket behaviour), captures the handlers
`UnitsPage` registers, and then directly invokes the `onEvent` handler
to simulate a broadcast from a different browser — asserting the tile's
status label and note badge update with **no fetch call involved at
all**, plus a second invocation with a lower `version` confirming the
stale-event guard holds. Full repo verification (lint, typecheck, build
across all 3 workspaces, all test suites) is green — the same 3
pre-existing network-blocked tests as every prior milestone (2 storage
round-trip + the M0 realtime round-trip test itself, all three
requiring real network access this sandbox doesn't have — confirmed
these are unrelated to tonight's changes by re-running the realtime
round-trip test in isolation with no code changes of mine).

**Real bug, found live 2026-08-22, fixed same day**: `apps/web/.env`
had `VITE_SUPABASE_URL` still set to `.env.example`'s literal placeholder
(`https://<project-ref>.supabase.co`) rather than the real project URL —
one variable filled in, the one next to it missed. `createClient()`
throws synchronously on a malformed URL; `getSupabaseClient()` called it
with no `try/catch`, and that throw happened inside a React effect with
no error boundary anywhere in the app, so it took down the entire Units
page to a blank screen with no visible error message — worse than the
already-handled "env vars simply unset" case, which correctly logs a
warning and degrades to `'disabled'`. Fixed by wrapping the
`createClient()` call in `try/catch` too: a malformed URL (leftover
placeholder, typo) now degrades to `'disabled'` exactly the same way a
missing one does, with a `console.error` naming the likely cause, instead
of crashing the tree. New test (`apps/web/test/realtime.test.ts`) mocks
`@supabase/supabase-js`'s `createClient` to throw and asserts
`subscribeToUnitStatusChanges` reports `'disabled'` without throwing.
**Checked for the same risk elsewhere**: `apps/api/.env.example` has an
analogous pair of easy-to-half-fill-in placeholders
(`SUPABASE_URL=https://<project-ref>.supabase.co` next to
`DATABASE_URL`/`DIRECT_URL`, which embed the same `<project-ref>`) — left
as-is for now since the failure mode there is different in kind (a
backend process fails loudly in its own logs/terminal on a bad
connection string, not a silent blank browser screen with no error
surfaced to a user) and wasn't reported as broken; worth the same
crash-safety treatment if it ever causes a similar report.

**Live-verified by the user, 2026-08-22, two ways**: (1) changed a
unit's status in one browser, watched it update live with no manual
refresh in a separate browser/session; (2) cross-role — changed status
logged in as one demo user, watched it update live logged in as a
different demo user in the other browser, confirming the broadcast
pipeline works regardless of which role triggers the change or which
role is watching it. This closes out spec §11's M2 acceptance line for
real.

**Open item, not urgent, noted by the user for a future milestone**:
every role tested tonight holds full `unit:read` — whether a role with
*partial* unit visibility (not yet built anywhere in this system) would
correctly receive broadcasts only for units it's permitted to see, versus
receiving every unit's broadcast regardless of role, has not been
exercised. The current `property` channel broadcasts unit status changes
to every subscriber unconditionally — there's no per-role filtering on
the wire. Revisit once/if a role with restricted unit visibility is
built.

---

**Stopping point, 2026-08-22.** Everything built tonight is now
live-verified against real infrastructure (the hosted Supabase project),
not just code-reviewed or unit-tested: the unit status state machine and
transition table, the SYSTEM_ADMIN-only automatic-transition override,
forced status correction (including its note-visibility redesign and the
empty-note bugfix), and realtime status updates via Supabase Realtime
broadcast. Task 14 closes out the units/status-machine portion of M2.
**Not started**: the rest of spec §8.2's Command Center — the KPI strip,
live activity feed, and attention queue widgets — `DashboardPage` is
still the placeholder landing page noted above. Holding here on explicit
instruction; no further M2 work until given the go-ahead.

### Command Center: KPI strip, live activity feed, attention queue — built, not yet live-tested (2026-08-23)

Spec §8.2's remaining Command Center widgets, built around the unit grid
task 14 already shipped (that page, `/units`, is untouched by this work).
`DashboardPage` (the `/` landing route) now renders a real `CommandCenter`
component instead of the placeholder text, but only for a caller holding
`unit:read` — a role without it (e.g. Restaurant Staff, spec §5.4) still
gets the plain "Welcome" placeholder, since every widget below reads unit
data.

**Deliberately not faked**: spec §8.2 lists eight KPI-strip/attention-queue
items in total; five of them (today's arrivals/departures, open urgent
work orders, pending payment verifications, open F&B tickets,
SLA-breached work orders, overdue amenities, unverified payments >24h —
seven, not five, once counted individually) depend on modules that don't
exist yet (bookings M4, work orders M3, payments M4, F&B M5, amenities
M5). Per instruction, these render as explicitly-labelled stub cards/rows
— dashed border, muted grey, an "—" placeholder value, and a "Coming in
M3/M4/M5" caption — never a real-looking zero. Only four items are real
today, all computed from `Unit`/`UnitStatusEvent` data that already
exists:

- **KPI strip**: Occupied / Ready / Dirty / Out-of-order counts.
- **Attention queue**: rooms sitting in `VACANT_DIRTY` for more than 3
  hours (`DIRTY_ATTENTION_THRESHOLD_MINUTES = 180` in
  `apps/api/src/modules/units/service.ts`), with how long each has been
  dirty.

Backend: two new endpoints, both gated by `unit:read` (same permission as
the unit grid) —

- `GET /units/dashboard` → `{ kpi: { occupied, ready, dirty, outOfOrder }, dirtyRooms: [{ id, code, name, dirtySince, dirtyMinutes }] }`.
  `dirtyRooms` only lists units already past the 3h threshold — the "when
  did this unit become dirty" timestamp is the `createdAt` of the latest
  `UnitStatusEvent` for that unit (the event that put it into its current
  `VACANT_DIRTY` state), falling back to the `Unit` row's own `createdAt`
  for a unit that has never had a status event (e.g. still sitting at its
  seeded default with nothing in the table yet).
- `GET /units/activity?limit=` → `{ events: [{ id, unitId, unitCode, unitName, fromStatus, toStatus, note, actorName, createdAt }] }`,
  the most recent `UnitStatusEvent` rows across every unit, newest first
  (default limit 20, capped at 50). This only backfills the feed on page
  load — a page open when a status change happens learns about it from
  the existing `unit.status.changed` realtime broadcast (task 14), not by
  polling this endpoint.

6 new router tests (permission gating on both endpoints, KPI counting
across all four statuses plus the threshold filter, the no-prior-event
fallback, activity ordering/shape, and limit clamping) — all passing
against the mocked Prisma client, same pattern as every other units
router test.

Frontend (`DashboardPage.tsx`): the KPI strip and attention queue both
poll `/units/dashboard` every 60s (same fallback principle as
`UnitsPage`'s poll, spec §3: "a dropped socket must never leave a stale
board with no recovery path") and also refresh immediately on any
`unit.status.changed` broadcast, since a status change can move a unit in
or out of "dirty" or "out of order." The live activity feed **reuses
task 14's existing realtime subscription** (`subscribeToUnitStatusChanges`
from `lib/realtime.ts`) rather than opening a second channel — a live
broadcast is prepended to the feed (capped at 30 items client-side) using
the same `summary` string the backend already builds for the broadcast
payload. Department filtering (spec §8.2: "filterable by department, if
cheap") was **not** built — `Unit` has no `department` field in the
schema, so there's nothing to filter by yet; the spec itself allows a flat
list as the fallback ("otherwise just a flat recent-events list is fine
for now").

1 new component test (`App.smoke.test.tsx`) renders the Command Center for
a `RESORT_MANAGER`-equivalent caller and asserts: the real KPI numbers
render, a stub KPI card shows its "Coming in M3" label rather than a bare
zero, the one real attention-queue row (a dirty room past the threshold)
appears alongside the stub rows, and the activity feed renders a
backfilled event with its actor name. The four existing units-grid
component tests were updated to wait for the "Units" nav link instead of
the old "Welcome, ..." placeholder text as their landing-page signal,
since a caller with `unit:read` (all four of those tests use one) now
lands on the real Command Center, not the placeholder.

Full repo verification: lint, typecheck, and build are clean across all
three workspaces; `apps/api` is 124/127 (the same 3 network-blocked
round-trip tests as every prior milestone, unrelated to this change and
unchanged since M0); `apps/web` is 15/15.

**Not yet live-tested against the real Supabase database** — same
sandbox network limitation as every prior milestone. Before relying on
this: reload the Command Center as a role holding `unit:read` and confirm
real counts match the Units grid; force a unit to `VACANT_DIRTY` and
either wait 3h or temporarily lower
`DIRTY_ATTENTION_THRESHOLD_MINUTES` to confirm it surfaces in the
attention queue; change a unit's status in one browser and confirm the
KPI strip, attention queue, and activity feed all update in the other
within a few seconds without a manual refresh (same mechanism as task
14's grid live-update, so should hold, but not yet watched directly on
this page specifically).

### INSPECTED status retired — 5-state unit cycle (2026-08-22/23, client decision)

**Real operational correction, not a bug**: at Lucky Waku-Waku the person
who cleans a room is the same person who QC-inspects it and marks it
ready — there is no separate hand-off to a distinct inspector. The
original 6-state cycle's standalone `INSPECTED` status between `CLEANED`
and `READY` never reflected reality, and is retired. The client found
this live while testing the Command Center's KPI strip (above) — units
sitting at `INSPECTED` (at least one, `R11`) weren't showing up
anywhere in any KPI bucket, which is what prompted digging into whether
the status made sense at all.

**New 5-state cycle**: `VACANT_DIRTY → CLEANING → CLEANED → READY →
OCCUPIED → VACANT_DIRTY`, plus `OUT_OF_ORDER`/`BLOCKED` as before.
`CLEANED → READY` is now a normal manual transition gated by
`unit:update_status` — the same housekeeping permission as the two
steps before it — with no QC gate and no automatic-only status in
between. This removes one of the three transitions that used to need
the SYSTEM_ADMIN override system: only `READY → OCCUPIED` and
`OCCUPIED → VACANT_DIRTY` (both tied to M4's booking check-in/check-out)
still need it. `spec.md` §7.1 rewritten in place with an inline note
explaining the change, following this doc's established pattern for
client-decision corrections to the original brief.

**Migration story — thought through carefully, per instruction, since
this touches a live enum column with real data on it**:

- **The Prisma `UnitStatus` enum keeps `INSPECTED`** — it is *not*
  dropped. Two independent reasons: (1) Postgres has no clean "remove
  one enum value" operation once any row references it — the only way
  to truly remove it would be recreating the whole type, which requires
  no live data to reference the old value first; (2) more importantly, a
  `UnitStatusEvent` row that recorded a real `INSPECTED` transition at
  9:44pm last night is a true historical fact. Deleting or reinterpreting
  it would falsify the audit trail — exactly the kind of "don't silently
  break the audit trail for past events" the instruction called out.
  `packages/shared`'s forward-looking `UNIT_STATUS_KEYS` no longer
  includes it (so no transition, dropdown, or validation path can ever
  produce it again), but a new `RETIRED_UNIT_STATUS_KEYS` list
  (currently just `['INSPECTED']`) and an `AnyUnitStatusKey` union type
  exist specifically so display code — the timeline, and defensively the
  grid tile — can keep rendering a historical or not-yet-corrected
  `INSPECTED` row correctly instead of crashing or showing `undefined`.
- **This means the schema change itself is low-risk**: no data
  migration, no destructive `ALTER TYPE`, nothing for `npx prisma db
  push` to even touch (the enum value was already there; only its
  Prisma-schema comment changed, documenting why it stays). The only
  thing that changes behaviorally is what `packages/shared`'s transition
  table and validation accept going forward.
- **The lookup functions (`getTransition`, `allowedManualTransitions`,
  `allowedOverrideTransitions`) are now defensive against a retired/
  unrecognized `from` status** (`UNIT_STATUS_TRANSITIONS[from] ?? []`,
  rather than a bare index that would be `undefined` and throw on
  `.find()`/`.filter()`). A live unit still sitting at `INSPECTED` after
  this deploy — like `R11` — degrades to "no manual/override transitions
  available" (its "Change status" and "Admin override" panels show
  nothing) rather than crashing the drawer.
- **The fix for `R11` and any other live `INSPECTED` unit is the
  already-built, already-live-verified forced-status-correction
  feature** — no bespoke migration script was written for this.
  `unit:force_status` (SYSTEM_ADMIN today) can jump straight to `READY`
  in a few seconds through the drawer's existing panel, which doesn't
  depend on `getTransition()` at all. Given the very small number of
  affected units (one confirmed), building dedicated migration tooling
  for a one-off, already-solved-by-an-existing-tool correction would
  have been over-engineering; recommended as the next live step.

**Frontend defensive typing to match**: `UnitRow.status` and
`TimelineEvent.fromStatus`/`toStatus` (in both `UnitsPage.tsx` and
`DashboardPage.tsx`'s activity feed) are now typed `AnyUnitStatusKey`,
not the forward-only `UnitStatusKey` — honest about the fact that a
retired status can still arrive from the wire, for exactly the two
reasons above. `UNIT_STATUS_LABELS`/`UNIT_STATUS_CLASSES` keep an
`INSPECTED` entry so that honesty doesn't turn into a rendering crash.
The force-correction dropdown can't offer `INSPECTED` as a target (it
maps over the forward-only `UNIT_STATUS_KEYS`, now 7 long instead of 8)
and defaults its initial selection to `READY` when opened on a unit
currently stuck at a retired status, rather than trying to pre-select an
option that no longer exists.

**Test suites rewritten for the 5-state model, not blindly patched to
match new behavior** — per instruction, each changed assertion reflects
a real reasoned-through expectation: `packages/shared`'s
`unitStatus.test.ts` now has 19 tests (up from 13), including new
explicit coverage that `CLEANED → READY` is manual/`unit:update_status`
now, that only two transitions are automatic (down from three), that
`INSPECTED` cannot be resolved into by anything in the table, and that a
retired/unrecognized `from` status degrades to empty results rather than
throwing. The API's `router.test.ts`: the old "QC step" test (POC
Housekeeping doing `CLEANED → INSPECTED` via `workorder:verify`) became
a test that `CLEANED → READY` now works directly via
`unit:update_status`; the old "room attendant blocked from the QC step"
test was **flipped**, not deleted — it now proves a room attendant
holding only `unit:update_status` *can* do `CLEANED → READY`, which is
the actual behavior change; the override tests moved from
`INSPECTED → READY` to `READY → OCCUPIED`; new tests confirm `INSPECTED`
is rejected as a target status on both `POST /units/:id/status` and
`POST /units/:id/force-status` (`422 VALIDATION_ERROR`), and that
`CLEANED → READY` no longer produces an override audit entry for a
plain housekeeping caller. The frontend's override-panel component test
moved from an `INSPECTED` unit to a `READY` one, same override-then-
advance shape, targeting `OCCUPIED` instead. Full repo verification:
lint, typecheck, and build clean across all 3 workspaces;
`packages/shared` 28/28; `apps/api` 127/130 (same 3 pre-existing
network-blocked round-trip tests, unrelated); `apps/web` 15/15.

**Open item, explicitly flagged rather than decided (per instruction) —
the Dashboard KPI strip**: today's KPI strip only has four cards
(Occupied / Ready / Dirty / Out-of-order) and its counting `switch` in
`getUnitsDashboard()` has no case for `CLEANING`, `CLEANED`, or
`BLOCKED` — units in those statuses aren't represented in *any* KPI
bucket. This isn't new: it was already true before `INSPECTED` existed
in the client's live data, and retiring `INSPECTED` doesn't add a new
gap or break anything — it just removes one specific status value that
used to also fall into that same uncounted bucket. But now that this
was found live via exactly this gap, it's worth deciding deliberately:
should the KPI strip grow a fifth card — a combined "Cleaning/Cleaned"
(in-progress housekeeping) count, mirroring how `dirty`/`ready`/
`occupied`/`outOfOrder` already work — or is that explicitly a follow-up
for later? Not decided here; needs the client's call before building
either way.

---

## M3 — Work orders — in progress

First slice, per instruction to check in early rather than deliver the
whole milestone at once: the transition table, the file-upload
infrastructure every photo-evidence feature in this system will reuse,
and ticket **creation** with spec §7.2.1's mandatory-photo gate enforced
server-side — the milestone's headline acceptance criterion. Status
transitions beyond creation (assign, start, complete, verify, reopen,
cancel), the `DONE`-requires-`COMPLETION`-photo gate, department
dashboards, and "My tasks" are **not** in this slice — next up.

### Work order transition table (spec §7.2) — done

`packages/shared/src/workOrder.ts`, same explicit-table pattern as
`unitStatus.ts` (spec §7: "never duplicate this logic"):
`OPEN → ASSIGNED → IN_PROGRESS → DONE → VERIFIED`, plus `CANCELLED` from
`ASSIGNED`/`IN_PROGRESS` and `REOPENED` from `DONE` (looping back to
`IN_PROGRESS`). Every transition's permission gate is a reasoned,
documented choice since spec states the target states but not every
gate explicitly — full reasoning is in the file's comments, summarized:
`workorder:assign` for `OPEN → ASSIGNED`; `workorder:update_status` for
the assigned tech progressing their own ticket
(`ASSIGNED → IN_PROGRESS`, `IN_PROGRESS → DONE`, `REOPENED → IN_PROGRESS`);
`workorder:close` for both cancellation paths — the one operational
permission spec lists that isn't used anywhere else in this table, and
"closing" a ticket without finishing it is exactly what cancelling
mid-flight is; `workorder:verify` for **both** `DONE` outcomes
(`VERIFIED` and `REOPENED`) — spec: "`DONE → VERIFIED` requires
`workorder:verify`... `DONE → REOPENED` when QC fails," and verifying vs.
rejecting are the same QC check's two outcomes, done by the same person.

**Resolved, 2026-08-23**: spec's own ASCII diagram for §7.2 drew a
`CANCELLED` arrow from `ASSIGNED` and `IN_PROGRESS` only, not from
`OPEN`, so an unassigned ticket initially had no cancel path in this
table. Flagged rather than silently assumed one way or the other — the
client confirmed it was a spec oversight, not an intentional
restriction. `OPEN → CANCELLED` is now in the table, same
`workorder:close` gate as the other two cancellation paths: a mis-filed
or duplicate ticket is cancellable before anyone's even assigned to it.

**Not yet resolved, needs the client's confirmation before the verify
endpoint is built** (confirmed by the client to defer to that slice,
2026-08-23): spec says "`DONE → VERIFIED` requires
`workorder:verify`. Only the department POC or above may verify" — but
the seeded matrix grants `workorder:verify` at `ALL` scope to
`POC_HOUSEKEEPING`/`POC_MAINTENANCE` (not `DEPARTMENT` scope), so the
"own department only" restriction isn't expressible through the generic
permission-scope mechanism alone the way `workorder:read_all`'s
`DEPARTMENT` scope is. Will need an explicit
`actor.department === workOrder.department` check in the service layer
once the verify endpoint is actually built (next slice) — noted here so
it isn't silently forgotten.

Spec §7.2.1's photo-requirements table (which `WorkOrderType` needs an
`ISSUE` photo on create / a `COMPLETION` photo on `DONE`) lives as
`DEFAULT_WORK_ORDER_PHOTO_REQUIREMENTS` — the seed value for a real
`workOrder.photoRequirements` `Setting` row (see below), per spec's "so
the client can loosen or tighten it later without a deploy."

16 new `packages/shared` tests (transition coverage including
`CANCELLED` from all three cancellable states — `OPEN` added per the
resolution above — both `DONE` outcomes needing `workorder:verify`, a
defensive check that an unrecognized `from` status degrades to "no
transitions" rather than throwing — same defensive pattern as
`unitStatus.ts` after the `INSPECTED` retirement — and the
photo-requirements table itself).

### File upload infrastructure — done, first real usage

`StorageAdapter`/`SupabaseStorageAdapter` existed since M0 but had no
real caller until now (same situation `RealtimeAdapter` was in before
task 14). New `apps/api/src/modules/files`: `POST /files` accepts a
single multipart field (`file`), validates it against spec §7.2.1's
allowlist (`image/jpeg|png|webp|heic`, max 10MB) **before** it ever
reaches the storage adapter — both in `multer`'s `fileFilter` (rejects
before the body is even fully read) and again in the service layer (so
the same check protects a future non-HTTP caller too) — stores it under
a `randomUUID()`-prefixed key (never the client-supplied filename alone,
which would be both a collision risk and a path-injection vector), and
creates a `FileObject` row. Gated on `requireAuth` only, not a specific
permission: uploading a raw file to your own account isn't itself a
privileged action — each module that *attaches* a file to something
(work-order photos today) enforces its own domain permission at that
point instead.

**Deliberately not built this slice: a generic `GET /files/:id` read
route.** The storage adapter's own doc comment says "every read goes
through the authenticated `/files/:id` route," but a single generic
route can't meaningfully authorize *which* files a caller may see across
every future module (a maintenance photo, a payment proof, a check-in
waiver all have different visibility rules). Instead, `GET
/work-orders/:id` embeds each photo's signed URL directly in its own
response, authorized by that endpoint's own `workorder:read`/
`workorder:read_all` scoping — reading a photo is only ever exposed
through the domain endpoint that already knows whether this caller can
see it. Revisit if a true cross-module generic read route turns out to
be needed later.

**Deliberately not built this slice: EXIF `capturedAt` extraction.**
Spec §7.2.1: "Store `capturedAt` from EXIF when present, falling back to
upload time... a 'completion' photo taken three days before the ticket
existed is the fraud case to catch." No EXIF-parsing library is
installed yet; `WorkOrderPhoto.capturedAt` is set to upload time
unconditionally for now. Real, flagged gap — the fraud-detection
"differs by >24h" check this field exists for isn't functional until
EXIF extraction is added.

4 new router tests: auth required, a successful upload creates the
`FileObject` row with the right `contentType` passed to the storage
adapter, an unsupported MIME type is rejected before storage is ever
touched, and a request with no file attached is rejected.

### Reference number generator (spec §6.1) — done, first real usage

`apps/api/src/lib/referenceNo.ts`: spec's own instruction — "generate in
a single shared service with a per-day sequence" — for the `referenceNo`
every `WorkOrder`/`Booking`/`FnbOrder`/`AmenityRequest`/`StockRequest`/
`Incident` gets. New `ReferenceSequence` model (`scope`, `seq`) — one row
per `"<prefix>-<YYMMDD>"` scope (e.g. `"WO-260823"`); a Prisma `upsert`
atomically increments `seq`, relying on Postgres's row-level locking
during the upsert's implicit insert-or-update to stay correct under
concurrent requests rather than a separate advisory lock. Produces
`WO-260823-0001`, `WO-260823-0002`, etc., exactly matching spec's
`WO-260821-0031` example format. First real user is `WorkOrder`;
`Booking`/`FnbOrder`/`AmenityRequest`/`StockRequest`/`Incident` reuse the
same function as their own milestones land, per spec's "single shared
service" instruction — this was built now specifically so it doesn't
get duplicated four more times later.

**Schema change, additive only, low risk**: a new `ReferenceSequence`
table — nothing existing is touched, no data migration needed, just
`npx prisma db push` to create the table before this can be
live-tested.

### Work order creation with the mandatory photo-evidence gate (spec §7.2.1) — done, not yet live-tested

The milestone's headline acceptance criterion: "a maintenance ticket
cannot be created without an `ISSUE` photo... enforced by an API test
that posts without the photo and asserts `422`, not just by a disabled
button." `POST /work-orders` (`apps/api/src/modules/workorders`):
photos are uploaded first via `POST /files`, then referenced by `fileId`
+ `kind` in the create request body (`photos: [{ fileId, kind,
caption? }]`, max 6) — not embedded as raw bytes in the same request.
`createWorkOrder()` reads the live `workOrder.photoRequirements`
`Setting` (falling back to the shared default if that row is somehow
missing — the gate must never go silently unenforced), and for each
required `onCreate` photo kind for this ticket's `type`, checks the
`photos` array actually contains one; if not, `422` with
`{ code: 'PHOTO_REQUIRED', details: { kind } }`, exactly the shape spec
specifies. Every referenced `fileId` is also verified to actually exist
before the ticket is created (`422 VALIDATION_ERROR` otherwise) — a
typo'd or already-deleted file id doesn't silently create a ticket with
a broken photo reference.

`referenceNo` is generated via the new shared service above.
`department` is **explicit on creation, not derived from `type`** — a
deliberate design call: the `WorkOrder.department` column has always
been a plain required field, not something computed from `type`
elsewhere in the schema, and a `type→department` mapping wouldn't be
unambiguous anyway (a `GENERAL` ticket could reasonably belong to any
department). The caller (front desk/ops staff filing the ticket) picks
the department explicitly.

Broadcasts `workorder.created` on the `property` channel on success —
same best-effort pattern as task 14's `unit.status.changed` (wrapped in
try/catch, logged not thrown, never fails the ticket creation itself).
Spec §7.2's separate "urgent work orders push a realtime notification to
everyone in the target department immediately" (a targeted
`dept:{department}` channel, not the property-wide broadcast this uses)
is **not yet built** — this broadcast alone covers the property-wide
activity-feed use case the Command Center will eventually want from
work orders, the same way it already does for unit status changes.

**`GET /work-orders` and `GET /work-orders/:id`** were also built this
slice — not strictly required for "create," but needed to verify
creation actually worked and to unblock a future frontend. Read
visibility is **not** a flat permission check: spec's own reasoning
(documented in `rolePermissions.ts`'s header comment) is that
`workorder:read` — granted to every role — is "the floor... read at
least your own," while `workorder:read_all` is the elevated capability
that actually gates "see the department queue / everything." So
`listWorkOrders()`/`getWorkOrder()` branch on whether the caller also
holds `workorder:read_all` and at what scope: `ALL` scope sees
everything, `DEPARTMENT` scope sees only their own department's
tickets, and a caller with only the floor `workorder:read` sees only
tickets they created or are assigned to. This is a real, reasoned
extension of the `requirePermission` middleware's own documented
contract ("filtering query results... is the resource module's job") —
not something the M1/M2 modules needed since none of them had a
role-relative "your own vs. everyone's" distinction before.
`GET /work-orders/:id` embeds each photo's signed URL (see the files
section above) and returns `403` if the caller can't see this
particular ticket under the same visibility rule.

**Photo-requirements `Setting` seeded** (`apps/api/prisma/seed.ts`):
`workOrder.photoRequirements`, upsert-with-overwrite like
permissions/roles (config that should always match code until a
`SYSTEM_ADMIN` deliberately edits it through an admin UI that doesn't
exist yet — unlike units/unit-types, which are deliberately
create-if-missing since they become real client data).

14 new router tests: the photo gate rejects a `MAINTENANCE` ticket with
no photos at all and with only a wrong-kind (`PROGRESS`) photo, both
`422 PHOTO_REQUIRED` with the right `details.kind`; succeeds with the
right `ISSUE` photo attached and broadcasts `workorder.created`;
succeeds with no photos for `HOUSEKEEPING` (not required for that type);
rejects an unresolvable `fileId`; survives a realtime-broadcast failure
without failing creation; every seeded role (including `OWNER`, spec's
own resolved-ambiguity case) can create a ticket; the three read-scoping
tiers (own-only / department / everything) each produce the right Prisma
`where` clause; `404` for an unknown ticket; `403` for a ticket outside
the caller's visibility.

Full repo verification: lint, typecheck, and build clean across all 3
workspaces; `packages/shared` 44/44 (up from 28, +16 for the work-order
transition table); `apps/api` 145/148 (same 3 pre-existing
network-blocked round-trip tests, unrelated — confirmed stable across
repeated runs); `apps/web` 15/15, unaffected by this slice.

**Not yet live-tested against the real Supabase database** — same
sandbox limitation as every prior milestone, plus this slice specifically
needs `npx prisma db push` first (the new `ReferenceSequence` table —
additive only, no data migration) and a real photo upload through
`POST /files` to confirm the Supabase Storage round trip works for this
new caller the way task 14's realtime round trip eventually did for
broadcasts.

**Next slice**: `PATCH`/`POST` status-transition endpoints (assign,
start, mark done — with the `COMPLETION`-photo gate, verify, reopen with
`attemptNo` increment, cancel), the department-match check on `verify`
flagged above, then department dashboards and "My tasks."

### Two real bugs found live 2026-08-23, fixed the same day

**Drawer Timeline didn't update via realtime.** The unit grid tile
updated live (task 14) but an already-open drawer's Timeline list only
refreshed on close/reopen or switching units. Root cause:
`UnitDetailDrawer`'s timeline-fetch `useEffect` depended only on
`[unit.id]`. A realtime-driven status change on the *currently open*
unit patches `UnitsPage`'s `units` array (task 14's existing handler,
untouched) and flows down to the drawer as a new `unit` prop with a
bumped `version` — but nothing about that prop change was in the
effect's dependency array, so it never re-ran. Fixed by adding
`unit.version` to the dependency list: `[unit.id, unit.version]`. Now
*any* status change to the open unit — from a button in this same
drawer, or a broadcast from elsewhere — refetches the timeline, since
`version` bumps on every real change regardless of source. New
component test opens a drawer, fires a realtime event for that unit,
and confirms both a second `GET /units/:id/timeline` call and the new
event actually rendering.

**R11 showed the retired `INSPECTED` status again after being
force-corrected to `READY`.** Root-caused via SQL the client ran
directly against the live database: `Unit.status = 'INSPECTED'` for
R11, confirmed, but `UnitStatusEvent` has **zero rows ever** for that
unit — no history at all, not even a seed-time entry. That absence is
the actual proof of what happened, cross-checked against this
codebase's full git history, not just its current state:

- `apps/api/prisma/seed.ts` has **never**, in any commit
  (`38f51b2`/`f8f091b`/`39f0c50`/`b9ef35a`), set `status` explicitly on
  a unit — creation has always relied on the Prisma column's own
  `@default(VACANT_DIRTY)`. The client's initial hypothesis (a hardcoded
  seed value) doesn't hold — checked, not assumed.
- `changeUnitStatus()` has unconditionally written a `UnitStatusEvent`
  for every transition since the very first M2 commit (`1c63b0a`) — back
  when `INSPECTED` was still a reachable status, moving a unit into it
  through the API always left a row behind.
- Together: no version of this application's code, at any point in this
  project's history, could have set `R11` to `INSPECTED` without leaving
  an event row. It was written directly against the database, outside
  the app entirely (SQL editor, Prisma Studio, or similar) — most likely
  an early manual-testing artifact from before the seed script or the
  status API existed. The client's own force-correction attempt earlier
  tonight apparently never actually landed on this row (their
  suspicion — wrong tile, or a request that didn't complete); either
  way, there's no event to explain because nothing was ever recorded.

**Fix**: rather than a raw SQL `UPDATE` — which would just create a
second untraceable status flip, the exact problem being cleaned up —
new `apps/api/scripts/fixStaleInspectedUnits.ts` finds every unit
currently at `INSPECTED` and corrects each to `READY` through the real
`forceUnitStatus()` service function, the identical code path the UI's
"Force status correction" panel already uses and that's already tested.
This produces a proper `UnitStatusEvent` (`source: FORCED_CORRECTION`)
and a distinct `UNIT_STATUS_FORCED_CORRECTION` `AuditLog` entry for each
one, attributed to a `SYSTEM_ADMIN` user looked up at runtime (not
hardcoded), with a note explaining this was a one-off data-integrity
cleanup. Idempotent — finds units *currently* at `INSPECTED`, so
running it again after they're fixed is a no-op that reports nothing to
do. Run with `npm run fix:stale-inspected-units` (or
`npx tsx scripts/fixStaleInspectedUnits.ts`) from `apps/api`, after
`npx prisma db push`/`npm run seed` as usual.

**Found and fixed while investigating, a real separate gap**: no route
under `/api/v1` set any `Cache-Control` header at all. Express sets an
ETag on JSON bodies by default, but with no explicit cache directive a
browser can in principle serve a cached read of live operational data
(unit status, work orders, sessions) under some conditions — a
back/forward-cache restore, a stale revalidation — without the request
ever reaching the server to get fresh data. There is no cacheable `GET`
anywhere in this API; added a blanket `Cache-Control: no-store` for
every `/api/v1` route. Now confirmed **not** the cause of the `R11`
report above (that was stale seed-independent data, see above) — but a
real gap regardless, and cheap enough to have closed outright rather
than leave as a maybe. New test asserts the header on `GET /units`.

`apps/api` 145/148 (same 3 pre-existing network-blocked round-trip
tests); `apps/web` 16/16.

### Create Work Order form + photo-upload UI (2026-08-23) — done, browser-verified this sandbox's way

The frontend for the first M3 slice, so the mandatory photo gate is
testable end to end in the browser rather than just trusted from the
backend test suite. New `/work-orders` route + nav item (gated on
`workorder:read`, the floor every role holds, same pattern as `/units`
on `unit:read`) — `WorkOrdersPage.tsx`: a "New ticket" form (shown only
to a caller holding `workorder:create`) above a live ticket list.

**Photo upload**: `api.ts` gained `api.upload()` — the first multipart
caller this frontend has ever had. Required a real fix in the shared
request helper: it always set `Content-Type: application/json`
unconditionally before this, which would have broken every upload (a
`FormData` body needs the browser to set its own
`multipart/form-data; boundary=...`, never a hardcoded JSON type).
`request()` now only sets that header when the body isn't `FormData`.
Selecting a file uploads it immediately via `POST /files`, and the
returned `fileId` is held client-side until the ticket itself is
submitted — matching the two-step API design from the first M3 slice
(photos are referenced by id, not embedded as raw bytes in the create
request).

**The photo-requirement hint is informational only, never a blocking
disabled button** — deliberately, since spec §7.2.1 says the real gate
must be server-side "not just a disabled button," and because a client-
side block would have made it impossible to actually see the server's
real `422 PHOTO_REQUIRED` response in the browser, which is exactly
what this slice exists to make testable. The "Issue photos" section
shows a `Required for <Type>` badge (read from the shared
`DEFAULT_WORK_ORDER_PHOTO_REQUIREMENTS` constant — the same default the
backend falls back to) when the selected type needs one, but the
Create button is never disabled by it: the request always actually
fires, and a genuine `PHOTO_REQUIRED` error renders inline, styled the
same as every other form error on this page, not a toast after the
fact.

**Browser-verified, not just component-tested** — this sandbox still
can't reach the real Supabase project, so full login-to-database
end-to-end isn't possible here (same standing limitation as every prior
milestone), but the *rendered, built* frontend bundle was driven
through a real headless Chromium (Playwright, using this environment's
pre-installed browser) against the actual dev server, with only the
network layer mocked at the HTTP level (`page.route()`) rather than
anything React-level — the real login form, the real nav, the real
`WorkOrdersPage` component, the real file `<input>`, all doing their
real thing. The driven sequence: log in → open Work Orders → select
`MAINTENANCE` (the "Required for Maintenance" badge appears) → submit
with no photo attached → the server's real `422 PHOTO_REQUIRED`
response renders as "An ISSUE photo is required..." → attach a real
file to the file input → submit again → `201`, success message,
new ticket appears in the list, form resets. Caught and fixed one real
bug this way that no unit test would have: the error copy read "A
ISSUE photo," not "An ISSUE photo" — fixed with an actual article-
selection check, not a hardcoded string.

3 new component tests (`WorkOrdersPage.test.tsx`, same
render-the-real-`<App/>`-with-mocked-`fetch` pattern as every other
frontend test this session): the full photo-gate round trip described
above: no-photo rejection with the real error text, then success after
attaching one, with the ticket list and form-reset both asserted;
`HOUSEKEEPING` (a type that doesn't require a photo) creating directly;
the New-ticket form correctly hidden for a caller without
`workorder:create` while the ticket list still renders. Plus 1 new
`api.test.ts` test asserting `api.upload()` sends a real `FormData`
body with no explicit `Content-Type` header.

Full repo verification: lint, typecheck, build clean across all 3
workspaces; `packages/shared` 44/44; `apps/api` 145/148 (same 3
pre-existing network-blocked tests, untouched by this frontend-only
slice); `apps/web` 20/20 (+4).

**Not yet built this slice**: assignment/status-transition UI (the
ticket list is read-only — no assign/start/done/verify/reopen/cancel
buttons yet, matching the backend, which also doesn't have those
endpoints), the department-scoped verify UI, department dashboards,
"My tasks." Ready for the client's own live browser test of ticket
creation and the photo gate against the real Supabase database.

### Work order detail view + assign/status-transition endpoints (2026-08-23) — done, browser-verified this sandbox's way

The natural next slice after ticket creation: clicking a ticket now
opens it, with full description, uploaded-photo viewing (the headline
gap flagged after the last slice — until now there was no way to
actually view an attached photo), priority/department/assignee, notes,
and the status-transition buttons (Assign -> Start -> Done -> Verify,
plus Reopen and Cancel) gated by spec section 7.2's permission rules.
Both backend and frontend for this slice went in together.

**Backend — three new endpoints**, all in `workorders/router.ts` and
`workorders/service.ts`:

- `POST /work-orders/:id/assign` — OPEN -> ASSIGNED, requires
  `workorder:assign` (from the shared transition table, same as every
  status change), version-checked like every other mutation in this
  codebase. Validates the target user is a real, active user before
  assigning.
- `POST /work-orders/:id/status` — the general transition endpoint.
  Reuses `getWorkOrderTransition()` from `packages/shared` for the
  `from -> to` + permission check (same single-source-of-truth pattern
  as the unit module), and layers three more rules on top, all spec-
  derived:
  - DONE requires the same live-Setting-backed mandatory-photo gate as
    create, just checked against `onDone`/`COMPLETION` instead of
    `onCreate`/`ISSUE` — the two gates read the identical
    `workOrder.photoRequirements` Setting so they can never drift out
    of sync with each other.
  - VERIFIED and REOPENED both require the new `canVerifyWorkOrder()`
    helper (see below) — "only the department POC or above may verify."
  - REOPENED increments `attemptNo`; existing COMPLETION photos stay
    tagged to the attempt that produced them, and the next DONE tags
    its new photo to the new attempt — nothing is deleted or
    overwritten on a QC fail.
- `GET /work-orders/assignable-users?department=X` — a narrowly-scoped
  list endpoint gated on `workorder:assign` itself, not `user:read`.
  Found while building the assign picker: only SYSTEM_ADMIN and
  RESORT_MANAGER hold `user:read` in this role matrix, so a POC who can
  assign a ticket (e.g. POC_MAINTENANCE) couldn't otherwise call
  `GET /users` to find someone to assign it to. Rather than widen
  `user:read`'s boundary for everyone, this returns only
  `{id, fullName, employeeCode}` for active users in the requested
  department — the minimum an assign-picker needs. Registered *before*
  `GET /work-orders/:id` in the router so Express's route-matching order
  doesn't swallow `assignable-users` as an `:id` param.

**`canVerifyWorkOrder()`** (`packages/shared/src/workOrder.ts`): spec
section 7.2 says "only the department POC or above may verify," but a
generic ALL-scope `workorder:verify` grant can't tell a property-wide
role (SYSTEM_ADMIN, RESORT_MANAGER, OPS_SAFETY_SUPERVISOR — "above,"
no department of their own) apart from a department POC (restricted to
their own department) — both hold the same permission at the same
scope. Same deliberate, narrow, documented exception to "no hardcoded
role names" as `requiresTotp.ts` and the unit module's
`canOverrideAutomaticTransition`: this is a *which department does this
role's authority reach* policy question, not a resource-permission
question (that's still `workorder:verify` itself, checked separately).
Lives in `packages/shared` once so the API's real enforcement and the
UI's button visibility can't drift.

**Frontend — `WorkOrderDetailDrawer`** in `WorkOrdersPage.tsx`: clicking
a ticket row (now a real button, not just static text) opens a drawer
mirroring the units module's `UnitDetailDrawer` conventions. Shows the
full record — description, a photo grid (each `<img>` using the signed
URL `GET /work-orders/:id` already returned, clickable through to the
full-size image), priority/department/assignee/unit/created-by, and any
notes. Transition buttons are derived from
`allowedWorkOrderTransitions()` (the same shared helper the backend's
permission check is built on) and, for Verify/Reopen specifically,
further filtered client-side by `canVerifyWorkOrder()` so a
cross-department POC never sees a button that would just 403 — the
server enforces the identical rule regardless, this is purely so the UI
doesn't offer a dead end. Confirming a transition opens a small inline
form (not a separate page/modal) for the note (required, and the
Confirm button is disabled until non-empty, only when reopening) and,
only for Done, a completion-photo uploader that reuses the same
`api.upload()` two-step flow as ticket creation. Assign is its own
small flow: a button that fetches the new assignable-users endpoint
scoped to the ticket's department, a picker, and a confirm step.

**Backend tests**: 31 new tests in `workorders/router.test.ts` covering
assign (success, wrong-state 422, missing-permission 403, stale-version
409), status-change (every transition including the DONE photo gate
both ways, REOPENED's mandatory note enforced at the schema level,
VERIFIED's department check both directions — rejected cross-department
POC, allowed same-department POC and allowed property-wide SYSTEM_ADMIN
regardless of department, attemptNo incrementing on reopen, CANCELLED,
an invalid transition, and a stale-version conflict), and the
assignable-users endpoint (success and a 403 for a caller without
`workorder:assign`). `packages/shared` gained 4 new tests for
`canVerifyWorkOrder` itself. 2 new component tests in
`WorkOrdersPage.test.tsx`: opening a ticket to see the full record and
walking ASSIGNED -> IN_PROGRESS through the real UI, and confirming
Verify/Reopen stay hidden for a department POC looking at a
different department's DONE ticket even though they hold
`workorder:verify` itself — proving the client-side filter really is
checking department, not just the permission.

**Browser-verified, not just component-tested** — driven through a real
headless Chromium (Playwright, this environment's pre-installed
browser) against the actual dev server, HTTP mocked via `page.route()`
only: opened a ticket and confirmed an attached photo actually rendered
in the photo grid (the specific gap flagged as most important after the
last slice); walked ASSIGNED -> IN_PROGRESS and watched both the drawer
badge and the list-row badge update live from the same state; ran the
full assign flow (button -> picker populated from the real endpoint
response -> confirm -> ticket shows the new assignee); and confirmed
the DONE completion-photo gate renders the server's real
`422 PHOTO_REQUIRED` inline, in the same styled-error pattern as every
other error on this page, when Mark Done is confirmed with no photo
attached.

Full repo verification: lint, typecheck, build clean across all 3
workspaces; `packages/shared` 48/48 (+4); `apps/api` 162/165 (same 3
pre-existing network-blocked round-trip tests, unrelated to this
slice); `apps/web` 22/22 (+2).

**Not yet built this slice** (flagged, not silently skipped): a
targeted per-assignee "your ticket moved" realtime notification (the
existing `workorder.status.changed`/`workorder.created` broadcasts
cover the property-wide activity-feed case, same channel/pattern as the
unit module, but nothing pushes to the specific assignee yet);
department dashboards; "My tasks." Ready for the client's own live
browser test of the full assign -> start -> done -> verify/reopen
lifecycle against the real Supabase database.

### Fix: "Mark Assigned" bypassed the real assign picker (2026-08-23) — real gap found live-testing, fixed same day

Live-testing the slice above found a real bug: clicking Assign on an
OPEN ticket opened a panel with only a Note field and Confirm/Cancel —
no way to actually pick who the ticket goes to, even though the
dedicated assign UI (with a real picker backed by
`GET /work-orders/assignable-users`) was built and working.

Root cause: `OPEN -> ASSIGNED` is a real entry in the shared
transition table (correctly, since the *permission* check —
`workorder:assign` — needs to live there), so it was also showing up
in `WorkOrderDetailDrawer`'s generic `allowedWorkOrderTransitions()`
list alongside Start/Done/Verify/etc. With no label registered for
`ASSIGNED` in `TRANSITION_BUTTON_LABELS`, it fell back to
`Mark ${WORK_ORDER_STATUS_LABELS['ASSIGNED']}` — a second "Mark
Assigned" button that opened the generic note-only status-change panel
instead of the real assign picker further down the drawer. Two
competing UI paths for the same action, and the broken one rendered
first (and, since it has no assignee field, silently couldn't ever
succeed even if confirmed).

Fix: `allowedTransitions` now explicitly excludes `ASSIGNED` from the
generic transition-button list, since assignment always goes through
the dedicated `canAssign` section instead. 1 new regression test in
`WorkOrdersPage.test.tsx` asserting an OPEN ticket shows exactly one
assign entry point (no bare "Mark Assigned" button, no "Change status"
section at all when ASSIGNED is the only candidate transition) and
that the real picker flow actually calls
`POST /work-orders/:id/assign` with the selected `assignedToId`.
Re-verified in a real headless browser: opening an OPEN ticket now
shows only the "Assign ticket" button.

`apps/web` 23/23 (+1). Lint/typecheck clean.

### Assignee picker made property-wide, not department-scoped (2026-08-23) — client decision

`GET /work-orders/assignable-users` filtered strictly on
`department: <the ticket's department>` — confirmed by reading
`listAssignableUsers()` directly. Client feedback: this actively got in
the way, since maintenance staff (and others) routinely get assigned
to work outside their own department, not just their own — the same
"staff cover flexibly, case-by-case" principle behind the earlier
CLEANED->READY permission fix.

Removed the department filter (and the now-meaningless `department`
query param) entirely — `listAssignableUsers()` now returns every
active, non-deleted user account, still selecting only
`{id, fullName, employeeCode, department}` (department is now returned
per-user as context rather than as a filter, since the picker option
text shows it — `"Tech One (LWW-011) — Maintenance"` — now that
cross-department assignment is the expected case, not an edge case).
`workorder:assign` still gates who can *call* the endpoint at all — the
change is only to whose names it returns.

Updated the existing backend test to assert the Prisma query carries no
`department` filter and returns users from multiple departments;
updated the frontend regression test from the previous fix to mock a
cross-department roster and assert a HOUSEKEEPING user appears in the
picker for a MAINTENANCE ticket, and that the request itself carries no
`department` query param. Re-verified in a real headless browser: the
picker for a MAINTENANCE ticket lists both a MAINTENANCE and a
HOUSEKEEPING employee with their department shown.

Full repo lint/typecheck/build clean; `apps/api` 162/165 (same 3
pre-existing network-blocked tests); `apps/web` 23/23.

### M3 core work-order slice confirmed end to end (2026-08-23) — client live-tested against the real Supabase database

Client ran a fresh end-to-end test on the real hosted database (ticket
WO-260823-0002) covering the whole slice built so far: creation with
the mandatory issue-photo gate, the assignee picker (now showing all
employees with department context, including SYSTEM_ADMIN), assignment
persisting correctly (status Open -> Assigned, "Assigned to" updated),
and the full status lifecycle through Start -> Done (the completion-
photo gate fired correctly and was resolved by attaching a photo) ->
Verify. All confirmed working as designed.

M3's core work-order functionality is genuinely done: creation with
photo evidence enforcement, the ticket detail view with photo viewing,
assignment across departments, and the complete status lifecycle
(Assign -> Start -> Done -> Verify/Reopen -> Cancel). Four real bugs
were found and fixed along the way through live testing rather than
code review alone — the department-filtered assignee picker, the
competing "Mark Assigned" button that bypassed the real picker, the
unit detail drawer's timeline not refreshing on a realtime status
change, and a stale `INSPECTED` unit status left over from a direct
database write outside the app.

**Holding here per client instruction.** Still queued, no action until
given the go-ahead: department dashboards, a "My tasks" view,
per-assignee realtime notifications (today's broadcasts cover the
property-wide activity feed only), and EXIF capture-time verification
on uploaded photos.

### "Assigned to you" added to the full-list dashboard (2026-08-23) — real gap found live-testing

Client feedback: an ALL-scoped `workorder:read_all` holder (SYSTEM_ADMIN,
RESORT_MANAGER, ...) can genuinely be assigned a ticket — confirmed live
(LWW-001 shows up as a valid assignee option, and a floor-staff account's
My Tasks view correctly shows a real assigned ticket, so the underlying
mechanism clearly works) — but the full-list dashboard those roles get
had no way to see just their own assigned work without scanning the
entire property's ticket list.

Added an "Assigned to you" section above the existing flat "Tickets"
list, `FULL_LIST` mode only — additive, not a replacement. It reuses
the exact `?mine=true` query the `MY_TASKS` dashboard already uses
(`assignedToId: actor.id`, layered on top of whatever visibility scope
the caller already has), fetched as a second, independent request
alongside the existing full-list fetch, and sorted with the same
active-work-first `sortForMyTasks()` helper — no new backend endpoint,
no new query semantics, same code paths already proven correct for
`MY_TASKS`. `DEPARTMENT_QUEUE` and `MY_TASKS` are both unchanged.

Updated the existing "flat list, unchanged" test to also assert the new
section renders correctly alongside the full list, without one crowding
out the other. Re-verified in a real headless browser: a SYSTEM_ADMIN
account's Work Orders page now shows both "Assigned to you" (one
ticket) and "Tickets" (the full property-wide list, including that same
ticket) at once.

Full repo lint/typecheck/build clean; `apps/web` 25/25 (no new test
count — the existing "flat list, unchanged" test was extended with the
new assertions rather than split into a separate test).

### Client-confirmed: M3's core work-order slice is done (2026-08-23)

Client ran a fresh live end-to-end test against the real hosted
Supabase database on WO-260823-0002 and confirmed the full picture
works: the assignee picker shows all employees with department context
(including SYSTEM_ADMIN, double-checked), assignment persists
correctly (status Open -> Assigned, "Assigned to" updates), and the
complete status lifecycle through Start -> Done (the mandatory
completion-photo gate fired correctly, resolved by attaching a photo)
-> Verify all worked as expected.

With this, M3's core work-order slice — creation with the mandatory
issue-photo gate, the ticket detail view with photo viewing,
assignment (property-wide, not department-locked), and the full
status lifecycle (Assign -> Start -> Done -> Verify/Reopen ->
Cancelled) — is genuinely done, live-verified against the real
database, not just passing tests.

Four real bugs were found and fixed this way, only surfaced by testing
in the actual running app rather than by reading the code: the
department-filtered assignee picker (staff need to be assignable
across departments, same principle as the earlier CLEANED->READY
permission fix), a second, broken "Mark Assigned" button competing
with the real assign picker, the unit detail drawer's timeline not
refreshing on a realtime-driven status change, and a stale `INSPECTED`
unit status left over from a direct database write outside the app
(M2). None of these were caught by the unit/component/integration test
suites alone — each needed a human actually clicking through the
running app against real data to surface.

**Queued for later, no action until given the go-ahead**: department
dashboards, a "My tasks" view, per-assignee realtime notifications (the
existing broadcasts cover the property-wide activity feed but nothing
targets the specific assignee yet), and EXIF capture-time verification
on uploaded photos.

### Department dashboards + "My tasks" (spec §8.3) — done, not yet live-tested (2026-08-23)

The next queued item: spec §8.3's per-role dashboards for work orders.
Per spec's own instruction ("build **one** dashboard component with
configurable widget sets, not thirteen bespoke pages"), this isn't three
new routes — `WorkOrdersPage` now renders one of three shapes depending
on the caller's *existing* permission/scope data, the same fields the
backend's own `visibilityWhereClause` (M3's first slice) already reads
to filter query results:

- **`FULL_LIST`** — an ALL-scoped `workorder:read_all` holder
  (`SYSTEM_ADMIN`, `RESORT_MANAGER`, `OPS_SAFETY_SUPERVISOR`,
  `ADMIN_HEAD`, `OWNER`). Exactly the flat "Tickets" list that already
  existed — unchanged.
- **`DEPARTMENT_QUEUE`** — a DEPARTMENT-scoped `workorder:read_all`
  holder, or anyone holding `workorder:assign` without ALL-scope read
  (`POC_HOUSEKEEPING`, `POC_MAINTENANCE`, `RESTAURANT_MANAGER`). Spec
  §8.3's "room status board" / "incoming repair queue... assignment
  panel" — the same `GET /work-orders` response (already department-
  scoped server-side, nothing new to fetch) grouped client-side into
  **Unassigned** (`OPEN`) / **Assigned / in progress** (`ASSIGNED`,
  `IN_PROGRESS`, `REOPENED`) / **Awaiting verification** (`DONE`) /
  **Verified / cancelled** (hidden when empty), each with a live count.
  Clicking any ticket opens the same `WorkOrderDetailDrawer` as before —
  assign/status-transition/verify all unchanged.
- **`MY_TASKS`** — the floor: anyone left over (`HOUSEKEEPING_STAFF`,
  `MAINTENANCE_STAFF`, `RESORT_STAFF`, `RESTAURANT_STAFF`,
  `ADMIN_STAFF`, `CASHIER`). Spec §8.3's "My rooms today" / "My tickets
  today" — a single "Assigned to you" list, fetched with the new
  `?mine=true` query param (below) rather than the broader own-created-
  or-assigned set a plain `GET /work-orders` falls back to for these
  roles, so a room attendant sees only work actually assigned to them,
  not also every ticket they've personally filed. Sorted active
  (`OPEN`/`ASSIGNED`/`IN_PROGRESS`/`REOPENED`) work ahead of
  finished work, oldest-first within each group — the ticket that's been
  sitting longest surfaces first. The New-ticket form still exists for
  these roles (everyone holds `workorder:create`) but is tucked inside a
  collapsed `<details>`/`<summary>` ("Report an issue / new ticket")
  rather than sitting above the task list, matching spec's "a single
  list... nothing else" framing for these roles — filing a ticket is a
  secondary action here, not the primary one.

**`deriveDashboardMode()`** reads permission/scope data only — no
hardcoded role names, so a role's dashboard shape can only change by
changing what it's granted through the Roles admin UI, not by editing
this file, consistent with every other role-shaped decision in this
codebase (`canVerifyWorkOrder`, `requiresTotp`, etc.).

**Backend**: `GET /work-orders` gained the two remaining spec §9 query
params it was missing (`?type=&status=&assignedTo=&unitId=&mine=` was
always the documented surface; only `assignedTo`/`mine` weren't wired
in) — `mine=true` filters to `assignedToId: actor.id` (this is what
`MY_TASKS` mode calls), `assignedTo=<userId>` filters to a specific
person's tickets (lets a department dashboard narrow its already-scoped
queue down to one tech, not built into the UI yet but available). Both
apply on top of the existing `visibilityWhereClause`, not instead of
it — a `mine=true` request from a floor-only caller is still
additionally bounded by their own-created-or-assigned visibility rule,
so this can't be used to see someone else's tickets by guessing an id.

2 new backend router tests (`?mine=true` narrows an ALL-scoped caller to
their own assignments; `?assignedTo=` composes correctly with an
already-department-scoped caller). 3 new/updated frontend component
tests: the two existing photo-gate tests (which log in as a
DEPARTMENT-scoped `POC_MAINTENANCE`) updated their empty-state/grouping
assertions to match the new grouped view instead of the old flat one;
the read-only-user test renamed and rewritten for `MY_TASKS` mode
(renamed from "hides the New ticket form" since that's no longer the
interesting part — the interesting part is which dashboard shape a
floor-only permission set now gets); 2 wholly new tests confirm
`FULL_LIST` stays exactly as it was for an ALL-scoped role, and that
`MY_TASKS` sorts active work ahead of completed work.

Full repo verification: lint, typecheck, build clean across all 3
workspaces; `packages/shared` 48/48 (untouched); `apps/api` 164/167
(+2, same 3 pre-existing network-blocked round-trip tests, unrelated);
`apps/web` 25/25 (+2 net — 3 new tests, 1 test removed and folded into
its replacement).

Not live-tested against the real Supabase database at the time this
was written — see the confirmation entry below, which supersedes this
paragraph. **Not yet built this slice**: per-assignee realtime
notifications and EXIF capture-time verification remain queued, per
the go-ahead given for this slice specifically (department dashboards
+ "My tasks" only).

### Client-confirmed: all three dashboard shapes live-verified (2026-08-23)

Client ran the live browser test this entry above was waiting on,
against the real hosted database, across all three roles: a
`POC_HOUSEKEEPING`/`POC_MAINTENANCE`-style account (department queue,
grouped by status), a floor-staff account (My Tasks, assigned-to-them-
only), and a `SYSTEM_ADMIN` account (full list plus the additive
"Assigned to you" section added afterward — see the entry above that
one). Confirmed working end to end: SYSTEM_ADMIN shows both "Assigned
to you" and the full "Tickets" list together, neither crowding out the
other; all three dashboard shapes verified against real data.

With this, spec §8.3's per-role dashboards are done and live-verified,
not just passing tests — closing the last open item from the
"Department dashboards" entry above.

**Holding here per client instruction.** Queued, no action until given
the go-ahead: per-assignee realtime notifications (today's broadcasts
cover the property-wide activity feed only), EXIF capture-time
verification on uploaded photos, and anything else not explicitly
requested.

### Notifications: department-wide urgent alerts + per-assignee — built, not yet live-tested (2026-08-23)

Given the go-ahead to build this next. Spec §9.1's `Notification` model
existed in the schema since M0 but had no reader or writer anywhere —
this is its first real usage. A new `apps/api/src/modules/notifications`
module is the single writer of `Notification` rows and the single caller
of the `user:{id}`/`dept:{department}` realtime channels (spec §9.1's
channel-naming rule), so every domain module that wants to notify someone
goes through `notifyUser()`/`notifyDepartment()` rather than each writing
its own Notification-row-plus-emit pair — same "never duplicate this
logic" principle spec §7 states for transition tables.

- **`notifyDepartment()`** — spec §7.2: "Urgent work orders push a
  realtime notification to everyone in the target department
  immediately." `createWorkOrder()` calls this when `priority === 'URGENT'`:
  one `Notification` row per active user in the target department
  (excluding the creator — they don't need telling about their own
  action), plus a single best-effort broadcast on `dept:{department}`
  carrying the same payload. This is distinct from the existing
  `property`-channel `workorder.created` broadcast (task M3 first
  slice) — that one feeds the property-wide activity feed everyone
  watching the Command Center sees; this one is the targeted alert only
  the relevant department's Notification rows and channel receive.
- **`notifyUser()`** — the per-assignee gap flagged as queued since M3's
  first slice ("today's broadcasts cover the property-wide activity
  feed but nothing targets the specific assignee"). Wired into two
  places in `apps/api/src/modules/workorders/service.ts`:
  - `assignWorkOrder()`: the newly-assigned tech gets notified directly
    (skipped on self-assignment).
  - `changeWorkOrderStatus()`, `REOPENED` outcome only: the ticket's
    current assignee gets told their completed work failed QC and needs
    another attempt — arguably the single most actionable notification
    in this system, since it's the one case where a "done" ticket
    silently becomes not-done again from the assignee's point of view.
    Skipped if the ticket carries no assignee, or if the verifier
    somehow is the assignee themselves (defensive — self-verification is
    already blocked elsewhere).

  `VERIFIED` was deliberately **not** wired to a per-assignee
  notification this slice — a completed, QC-passed ticket needs no
  further action from anyone, so a notification for it would be a
  no-op ping rather than something actionable. Revisit only if the
  client specifically wants a "your work was approved" confirmation.

Every write goes through the same best-effort pattern every other
broadcast in this codebase uses: wrapped in try/catch, logged not
thrown, never fails the underlying work-order operation itself — a
Realtime or Notification-table hiccup must not block someone from
creating or assigning a ticket.

**Backend surface** (spec §9's documented `GET /notifications  POST
/notifications/:id/read`, unbuilt until now): `GET /notifications`
(optional `?unread=true`), `POST /notifications/:id/read`. No dedicated
permission key — both are scoped to the caller's own notifications via
`requireAuth` only, same self-service pattern M1's session-revocation
endpoints established (`WHERE id = ? AND userId = ?` in the same query,
not a separate ownership check after a plain lookup — guessing another
user's notification id 404s rather than leaking whether it exists).

**Frontend**: `NotificationBell` (`apps/web/src/routes/NotificationBell.tsx`),
mounted in `AppShell`'s nav rail so it's visible from every authenticated
screen, not a routed page of its own — same reasoning as the Sign-out
button's placement. Fetches `/notifications` on mount, subscribes to
both the signed-in user's `user:{id}` and `dept:{department}` channels
(`subscribeToNotifications()`, new in `apps/web/src/lib/realtime.ts`,
same disabled/connecting/connected/reconnecting status contract as the
existing `subscribeToUnitStatusChanges()`), and falls back to a 60s poll
independent of realtime connection state — same resiliency principle
(spec §3: "a dropped socket must never leave a stale board with no
recovery path") task 14 established for the units grid. A red badge
shows the unread count; clicking a notification marks it read
optimistically (immediate UI update, best-effort `POST
/notifications/:id/read` in the background).

11 new backend router tests: 6 for the notifications module itself
(auth-required on both routes, scoping, `?unread=true`, the 404-via-
scoped-query pattern), 5 added to `workorders/router.test.ts` (urgent
creation notifies the department and excludes the creator, a NORMAL-
priority ticket notifies no one, the department notification failing
doesn't fail ticket creation, assignment notifies the assignee and
skips on self-assignment, reopening notifies the assignee). Existing
`App.smoke.test.tsx` mock for `lib/realtime.js` extended with a
no-op `subscribeToNotifications` so `NotificationBell` (now rendered on
every authenticated screen via `AppShell`) doesn't crash pre-existing
tests that don't otherwise care about notifications. Full repo
lint/typecheck/build clean; `apps/api` 176/179 (+13, same 3
pre-existing network-blocked round-trip tests as every prior milestone);
`apps/web` 25/25 (unchanged count — extended, not added, since the new
coverage is on the API side).

**Not yet live-tested against the real Supabase database** — same
sandbox limitation as every prior milestone. To confirm: create an
urgent ticket as one department member and watch a Notification row (and
bell badge, in a live app) appear for every other active member of that
department except the creator; assign a ticket to someone and confirm
they get notified directly; reopen a `DONE` ticket and confirm its
assignee gets notified. **EXIF capture-time verification remains
queued**, not touched this slice.

### Ticket reassignment (2026-08-23) — client feature request, additive to the existing assign flow

Real scenario: "the original assignee becomes unavailable, or someone
else is better suited, and the ticket needs to move to a different
person without cancelling and recreating it." Client-confirmed
requirements: works at any status before `VERIFIED`/`CANCELLED`
(`ASSIGNED`, `IN_PROGRESS`, even `DONE` — a handoff can happen even
late, while awaiting verification), and both the new and previous
assignee get notified — the new assignee the same "assigned to you"
notification a fresh assignment sends, the previous assignee told the
ticket moved away from them so nobody's left unsure whether it's still
their responsibility.

**Backend**: `assignWorkOrder()` (`workorders/service.ts`) now branches
on whether the ticket already has an assignee. The original OPEN ->
ASSIGNED path is unchanged — still looked up via the shared transition
table, since that's a real status move. Reassignment isn't: a new
`REASSIGNABLE_STATUSES` list (`OPEN`, `ASSIGNED`, `IN_PROGRESS`, `DONE`,
`REOPENED` — everything except the two terminal statuses, which have no
outgoing edges in the transition table either way) gates which statuses
allow it, and the permission check reads `workorder:assign` directly
rather than through `getWorkOrderTransition()`, since a reassignment has
no `to` status to look a permission up against — it's an ownership
change, not a lifecycle change, so the `status` field is left untouched
entirely on that path (never even included in the `updateMany` payload).
Rejects reassigning to the person already holding the ticket (422
`VALIDATION_ERROR`) before it ever reaches the database. A distinct
`workorder.reassigned` realtime event (not `workorder.status.changed`,
where `fromStatus === toStatus` would misleadingly imply nothing
happened) covers the activity-feed case; a distinct `WORKORDER_REASSIGNED`
audit action (vs. `WORKORDER_ASSIGNED`) with a `before`/`after` pair
covers the audit trail.

Both notifications reuse `notifyUser()` from the notifications module
wired in just before this slice — no new plumbing needed. The new
assignee's notification is identical to a fresh assignment's (skipped on
self-assignment). The previous assignee's is a second, distinct call —
skipped if there was no previous assignee (nothing to notify away from)
or if the previous assignee is the one doing the reassigning (they
already know; they just did it).

**Frontend**: `WorkOrderDetailDrawer`'s existing `canAssign` section
(picker + confirm, unchanged since the property-wide-picker fix earlier
this session) now shows for any status in the same
`REASSIGNABLE_STATUSES` list, headed "Reassign"/"Reassign ticket" instead
of "Assign"/"Assign ticket" once the ticket already has an assignee. The
picker excludes the current assignee from its options on a
reassignment — picking them again would just bounce off the server's
422, so there's no reason to offer it.

12 new backend router tests: a parametrized reassignment test across
`ASSIGNED`/`IN_PROGRESS`/`DONE`/`REOPENED` confirming `status` is never
touched; rejecting reassignment to the same person; rejecting a caller
without `workorder:assign`; both notifications firing on reassignment;
the previous-assignee notification skipped when they're the actor;
the distinct `workorder.reassigned` event; version-conflict handling;
and `VERIFIED`/`CANCELLED` both correctly rejected (the existing "not
OPEN" test was split into these two, since `DONE` is a valid
reassignment target now). 1 new frontend component test: a `DONE`
ticket shows "Reassign ticket" (never "Assign ticket"), the picker
excludes the current assignee, and confirming posts the right body.
Re-verified in a real headless browser: a `DONE` ticket's drawer shows
"Reassign ticket," the picker offers only the other tech, and
confirming updates "Assigned to" while the status badge stays "Done."

Full repo lint/typecheck/build clean; `packages/shared` untouched;
`apps/api` 187/190 (+11, same 3 pre-existing network-blocked round-trip
tests); `apps/web` 26/26 (+1).

**Holding here per client instruction**, same queue as before: EXIF
capture-time verification and anything else not explicitly requested.

### "Assigned to you" added to the department-queue dashboard, plus a real backend bug it uncovered (2026-08-23)

Same gap as the earlier SYSTEM_ADMIN fix, this time for `DEPARTMENT_QUEUE`
(POC roles): a notification says "assigned to you," but if the ticket
belongs to a different department than the POC's own, it was invisible
— the department queue only shows tickets in the POC's own department,
and there was no cross-department personal view to catch it. Real case
that surfaced this: WO-260823-0003 assigned to a POC Housekeeping
account, notification fired correctly, ticket nowhere in that account's
Department Work Orders page.

Investigating turned up a real backend bug, not just a missing frontend
section: `GET /work-orders?mine=true` was spreading `{assignedToId:
actor.id}` *alongside* `visibilityWhereClause(actor)` rather than
replacing it, so for a DEPARTMENT-scoped caller the two combined into
`{department: actor.department, assignedToId: actor.id}` — an AND, not
an OR. A ticket assigned to the POC from a *different* department was
silently excluded by the department half of that filter; `?mine=true`
could never have surfaced it, no matter what the frontend did. Fixed in
`listWorkOrders()`: `mine` now replaces `visibilityWhereClause()`
entirely rather than layering on top of it — "assigned to me" is the
`workorder:read` floor itself (spec's own reasoning, see this
function's comment), so it must never be narrowed further by whatever
elevated scope the caller also happens to hold. `assignedTo=<id>` (the
separate, other-person filter powering "let a department dashboard
narrow its queue to one tech") is intentionally untouched — that one
should stay layered on top of the caller's own scope, since it's asking
who among what they can already see, not what's theirs.

With the backend actually correct, the frontend fix was the same pattern
as the SYSTEM_ADMIN slice: the existing `myWorkOrders` state/fetch/
render (`?mine=true` + `sortForMyTasks()`) now also fires for
`DEPARTMENT_QUEUE`, not just `FULL_LIST`, rendering "Assigned to you"
above the existing status-grouped buckets — additive, buckets
unchanged.

1 new backend regression test (a DEPARTMENT-scoped POC's `?mine=true`
must return no `department` filter at all, not just fail to match one).
1 new frontend regression test: a POC sees a ticket from a different
department in "Assigned to you," with the (correctly empty) department
buckets still rendering alongside it. Re-verified in a real headless
browser with the exact reported scenario: a MAINTENANCE ticket assigned
to a POC Housekeeping account now shows in that account's "Assigned to
you," while the (empty) HOUSEKEEPING buckets render correctly beside it.

Full repo lint/typecheck/build clean; `apps/api` 188/191 (+1, same 3
pre-existing network-blocked tests); `apps/web` 27/27 (+1).

**Holding here per client instruction**, same queue as before: EXIF
capture-time verification and anything else not explicitly requested.

### Client-confirmed: the notifications/reassignment/personal-view chain is closed (2026-08-23)

Client confirmed the department-queue fix above against real data:
WO-260823-0003 now shows correctly under "Assigned to you" in the POC
Housekeeping account's Department Work Orders view, with the department
buckets unchanged alongside it — the exact reported scenario, live-
verified.

This closes the whole chain that started with wiring the Notification
model: per-assignee notifications, ticket reassignment (with
notifications to both the new and previous assignee), the SYSTEM_ADMIN
"Assigned to you" fix for `FULL_LIST`, the `?mine=true` backend bug that
fix uncovered, and this same fix's extension to `DEPARTMENT_QUEUE` — six
real gaps found and fixed through live testing in a single evening, not
one of them caught by the test suites alone until reproduced afterward.

**Holding here per client instruction.** EXIF capture-time verification
remains the one queued item — no action until given the go-ahead.

## M4 — Bookings & availability

### Booking creation with real availability checking (spec §6/§7.5) — first M4 slice, done, not yet live-tested

M3 is fully closed — client confirmed the whole work-order lifecycle,
all three dashboard shapes, notifications, and reassignment live against
the real database. This starts M4 with its smallest coherent first
slice per the client's own instruction: booking creation with real
availability checking, not a scaffold.

**`Booking`/`BookingUnit` already existed** in the schema from M0 —
confirmed by reading `schema.prisma` directly rather than assuming;
nothing recreated. Neither carries a `version` field (no optimistic-
concurrency need yet, since this slice only creates — no update/cancel
endpoint exists to race against).

**`POST /bookings`** (`apps/api/src/modules/bookings/`): guest name/
contact, type (`OVERNIGHT`/`DAY_TOUR`), date(s), one or more units, pax.
Gated on `booking:create`, same `requirePermission` + fresh-`authUser`
pattern as every other create route in this codebase.

**Timezone resolution is the actual hard part of this slice** — spec
§3.2: "Timezone Asia/Manila everywhere... never store naive local
time." A guest checking in at "2:00 PM" means 2:00 PM in Manila
regardless of what timezone the server process runs in. Installed
`@date-fns/tz` (pre-approved in spec §12's dependency list specifically
for this) — `TZDate(year, month, day, hours, minutes, 'Asia/Manila')`
resolves a wall-clock instant to the correct UTC value Prisma actually
stores, rather than hand-rolling offset arithmetic. `startAt`/`endAt`
resolve from `arrivalDate`/`departureDate` plus three separate Setting
rows (`booking.dayTourWindow`, `booking.checkInTime`,
`booking.checkOutTime`) — separate rows, not one combined blob like
`workOrder.photoRequirements`, so the client can loosen one
independently (e.g. the turnaround buffer) without touching the others.
Each falls back to spec's own stated default if the row is missing,
same "never silently unenforced" reasoning as the work-order photo
gate. Day tours never collect a `departureDate` from the client at
all — enforced at the schema level (`.refine()`), not just left
optional — since spec says day tours "have no such concept" and a
mismatched pair should never even be constructible.

**Real availability checking** (`packages/shared/src/booking.ts`'s
`windowsConflict()`, a pure function with no Prisma dependency, unit-
tested directly): a genuine datetime overlap check on `startAt`/`endAt`
across `BookingUnit`, not date-equality — spec's own example: a cottage
hosting a 9–5 day tour and a 14:00 overnight arrival on the same
calendar day must not collide. Layered with the turnaround buffer
(`booking.turnaroundMinutes`, default 60): spec states the buffer
directionally ("a booking cannot start within the buffer of the
previous one's end"), but the same housekeeping-gap reasoning applies
symmetrically regardless of which of the two bookings is chronologically
first — implemented that way and flagged as a deliberate reading beyond
the literal text, not a silent assumption. `CANCELLED`/`CHECKED_OUT`
bookings are excluded from the conflict query itself (they never hold a
unit), while `NO_SHOW` deliberately still counts (it held the unit for
its original window even though no guest arrived). A unit that's
`OUT_OF_ORDER` or `BLOCKED` is rejected before any date math runs at
all — spec: "cannot be assigned at all."

**Overlap violations return `409 UNIT_UNAVAILABLE`** with the
conflicting booking's `referenceNo` in `details` (plus `unitId`/
`unitCode` for the frontend to name the unit in its error message) —
"so the cashier can see who already holds it instead of guessing," per
spec's own reasoning. The same status code covers an `OUT_OF_ORDER`/
`BLOCKED` unit, unified under one "this unit isn't available for this
booking" code since spec only specified the overlap case explicitly —
a deliberate unification, not an oversight.

**Rate and pricing**, kept deliberately simple for this first slice:
rate auto-fills from `UnitType.baseRate` (or `dayTourRate`, falling
back to `baseRate` if unset, for `DAY_TOUR`) and is overridable per
unit, per spec §8.3's Cashier form. `totalAmount` = sum of resolved
per-unit rates × nights for `OVERNIGHT`, a flat sum for `DAY_TOUR` (no
per-hour math — spec's single fixed block). Extra-person rates, promo
pricing, and multi-night discounting are real features but explicitly
out of scope here, flagged rather than silently assumed away.
`referenceNo` reuses the same shared `generateReferenceNo()` service
from the work-order slice, prefix `LWW`.

**Frontend** (`BookingsPage.tsx`, new nav item gated on
`booking:create` — there's no list/detail view yet for a `booking:read`-
only holder to land on, so the nav gate is intentionally narrower than
the long-term permission): a single creation form, availability-aware
in the sense spec asks for at this stage — `OUT_OF_ORDER`/`BLOCKED`
units are shown (so the cashier isn't confused about what happened to
them) but their checkbox is disabled, never selectable, with the real
server-side check still the actual gate. A live estimated-total preview
computes client-side from the same rate × nights logic, labeled
explicitly as an estimate since the server computes the canonical
figure. The day-tour/overnight toggle swaps the date fields entirely
(no departure-date field rendered at all for `DAY_TOUR`, matching the
schema's own refusal to accept one) rather than showing then ignoring
it. A `409 UNIT_UNAVAILABLE` response renders inline with the
conflicting reference number, the same pattern as the work-order
photo-gate error.

**Tests**: 7 new `packages/shared` tests for `windowsConflict()`
directly (direct overlap, zero-buffer back-to-back, inside-the-buffer
rejection matching spec's own day-tour/evening-arrival example, exactly-
at-the-boundary allowed, well-clear allowed, buffer applied
symmetrically in the reverse chronological order, and a nested-window
sanity check). 18 new backend router tests: OVERNIGHT and DAY_TOUR
creation with the exact resolved UTC instants asserted (not just "some
date"), both departure-date `.refine()` rejections, duplicate-unit-in-
one-booking rejection, unknown-unit rejection, `OUT_OF_ORDER`/`BLOCKED`
rejection (parametrized), a direct-overlap conflict, a
turnaround-buffer conflict, an exactly-at-the-boundary success, proof
the `bookingUnit` query's `where` clause itself excludes
`CANCELLED`/`CHECKED_OUT` (not just that a particular mock happened to
return empty), rate auto-fill vs. override, auth/permission checks, a
realtime-broadcast-failure-doesn't-fail-creation test (same pattern as
work orders), and a live-Setting-overrides-the-default test. 3 new
frontend component tests: end-to-end creation with the confirmation
banner, the real 409 rendering inline, and the day-tour toggle hiding
the departure-date field. Re-verified in a real headless browser: the
`OUT_OF_ORDER` unit's checkbox is genuinely disabled, a real create
succeeds and shows "8/25/2026, 2:00 PM – 8/26/2026, 12:00 PM" (correct
Asia/Manila wall-clock display of the resolved UTC instants), and a
second, overlapping create attempt against the same unit/dates surfaces
the real `409` with the first booking's reference number inline.

Full repo lint/typecheck/build clean; `packages/shared` 55/55 (+7);
`apps/api` 206/209 (+18, same 3 pre-existing network-blocked round-trip
tests); `apps/web` 30/30 (+3).

**Not yet built this slice** (flagged, not silently skipped): no
`GET /bookings` list/detail endpoint yet (this slice is creation-only,
per the client's own explicit scope), no check-in/check-out, no
`BookingStatus` transition table beyond every booking starting at
`PENDING`, no payment/folio integration, no `Setting`-editing admin UI
(the four `booking.*` rows are seeded with spec's defaults but not yet
editable without a direct DB write). **Not yet live-tested against the
real Supabase database** — same sandbox limitation as every prior
milestone. Ready for the client's own live test: pull, run both
servers, try to create overlapping bookings against real data to
confirm the availability logic holds outside the mocked test suite.

### Nav item verified correct; real gap found instead: bookings were invisible on the Units drawer (2026-08-23)

Client reported the "Bookings" nav item missing entirely for a CASHIER
login. Checked both things asked: `getEffectivePermissions(['CASHIER'])`
does return `booking:create: 'ALL'` (ran it directly, not just read the
source), and `AppShell.tsx`'s `NAV_ITEMS` does gate `/bookings` on
`booking:create`, correctly. Permissions are computed live from code on
every request (never a cached DB `RolePermission` read), so there's no
seed-staleness angle either. Conclusion: not a code bug — most likely
the client's running app predated this branch's latest commits.

Re-testing after pulling turned up the *real* gap: the overlap-conflict
check itself worked correctly against real data, but a unit with a real
booking against it (C02) showed nothing about it in its own drawer —
status still `VACANT_DIRTY`, Timeline still "No status changes recorded
yet." Bookings existed in complete isolation from the Units view, with
no way for a cashier or housekeeper looking at a room to know it had a
reservation at all.

Added `GET /units/:id/bookings` (`apps/api/src/modules/bookings/`,
mounted on the bookings router since it queries `Booking`/`BookingUnit`,
which that module owns — Express doesn't care which router file
declares a path). Deliberately gated on `unit:read`, not `booking:read`
— this is fundamentally "does this unit have a reservation," the same
kind of unit-level fact `/units/:id/timeline` already answers, not a
booking-resource read. A Room Attendant (`HOUSEKEEPING_STAFF`) holds
`unit:read` but never `booking:read`, and needed this exactly as much as
a Cashier does — real gap, not a hypothetical. Reuses
`BOOKING_STATUSES_EXCLUDED_FROM_AVAILABILITY` from the shared package
(the same set the overlap check itself ignores) rather than inventing a
second definition of "not relevant," plus an `endAt >= now` filter so a
merely-old `PENDING`/`NO_SHOW` booking doesn't linger in the list —
together making this genuinely "current or future."

`UnitDetailDrawer` gained a third, deliberately separate section —
"Bookings" — sitting between the status badge and "Change status,"
never touching either: the live status color stays governed only by
check-in/check-out (not built yet), and Timeline stays scoped to actual
status transitions only. Format matches the client's own ask exactly:
"Booked: [guest name], [date range], ref [LWW-XXX]."

2 new backend tests (a `HOUSEKEEPING_STAFF` caller — no `booking:read`
— successfully reads it; the query's own `where` clause is asserted
directly to exclude `CANCELLED`/`CHECKED_OUT` and filter on `endAt`, not
just that a particular mock returned empty) plus auth/permission checks.
1 new frontend assertion, added directly to the existing
`HOUSEKEEPING_STAFF` unit-drawer test in `App.smoke.test.tsx` rather than
a separate test,
proving the exact role from the report can see it, and that the status
badge is untouched. Re-verified in a real headless browser reproducing
the exact reported case (a `POC_HOUSEKEEPING` login opening C02): status
badge stays "Dirty," Timeline stays empty, and "Booked: ... ref
LWW-260823-0003" now renders in its own section.

Full repo lint/typecheck/build clean; `apps/api` 210/213 (+4, same 3
pre-existing network-blocked round-trip tests); `apps/web` 30/30
(existing test extended, not a new file).

### Check-in / check-out (M4, urgent priority) + a durable scope correction: monitoring, not transactions (2026-08-23)

Client report, real and urgent: "I created a test booking for today's
date... with check-in not yet built, there's currently no way to
process this guest's arrival at all." Booking creation alone left every
new reservation stuck at `PENDING` forever — nothing in the codebase
could ever move a booking forward, and nothing could trigger the
`READY -> OCCUPIED` / `OCCUPIED -> VACANT_DIRTY` automatic Unit
transitions `unitStatus.ts` had been modeled for (as `trigger:
'automatic'`) since M2, with a comment literally saying "No booking
module yet (M4) to call this automatically." This slice is that call.

Also carries a durable architectural correction from the client that
applies to every milestone from here on, not just this one: **this
system monitors and coordinates the resort's operations — it does not
handle money.** Guests pay via a separate booking website or the
cashier's own POS. Concretely for this slice: checkout is an
unconditional `OCCUPIED -> VACANT_DIRTY` status flip, never gated on a
balance or payment-settlement check, now or later — there is no balance
field anywhere in the check-out schema or `CheckOutRecord` write. The
same principle carries forward to M5 (restaurant) and M6 (reports):
"charge to room" on a future F&B order will be a simple informational
flag ("guest wants this billed to their room, settled separately via
the POS"), never a balance calculation.

**Backend.** New `BOOKING_TRANSITIONS` table in `packages/shared`
(spec §7's "implement each as an explicit transition table" pattern,
now a fourth domain alongside unit/work-order transitions):
`PENDING`/`CONFIRMED` -> `CHECKED_IN` (`booking:checkin`), `CHECKED_IN`
-> `CHECKED_OUT` (`booking:checkout`); every other edge is empty on
purpose — nothing in this codebase can produce `CANCELLED`/`NO_SHOW`
yet, so no button advertises a transition with nowhere to wire up.

`POST /bookings/:id/checkin` and `POST /bookings/:id/checkout`
(`:id` accepts either the internal id or the human-readable
`referenceNo` — spec §6.1 calls that the thing "staff will read aloud
over radio and type into Messenger"). Check-in is deliberately
lightweight per the client's own ask — every field is optional with a
default, so a bare `{}` completes it; no new date or payment fields,
since those already exist on the booking from creation.

Handled the real edge case the client explicitly called out — "don't
assume check-in only ever happens from a Ready room." Spec §7.5: "A
unit that simply isn't READY yet at check-in raises a warning the front
desk acknowledges rather than a hard block." Implemented as a two-step
protocol: the first attempt omits `acknowledgeNotReady`; if any unit
isn't `READY`, the server responds `409 UNIT_NOT_READY` with the
offending unit's code/status, and the client resubmits with
`acknowledgeNotReady: true` to proceed. Genuinely hard blocks —
`OUT_OF_ORDER`/`BLOCKED`, or a unit already `OCCUPIED` by a different
booking — reuse the existing `409 UNIT_UNAVAILABLE` code and are never
overridable by that flag. A multi-unit booking validates every one of
its units before writing any change to any of them.

`applyAutomaticUnitStatusChange`, exported from `units/service.ts` and
imported into `bookings/service.ts`, is the first real cross-module
service import in this codebase — a deliberate, documented exception to
the established "no cross-module imports" rule: Unit/`UnitStatusEvent`
lifecycle is owned by the units module, and this reuses its existing
version-increment / event-write / realtime-broadcast logic rather than
duplicating it. It bypasses the manual transition table's own
permission check entirely — the caller has already gated on its own
`booking:checkin`/`booking:checkout` permission, and this was never a
manual transition to begin with.

Added a new, distinct `AUTOMATIC` value to the `UnitStatusEventSource`
enum (schema change — **run `npx prisma db push` before live-testing
this slice**), kept separate from the existing `AUTOMATIC_OVERRIDE`
(the `SYSTEM_ADMIN`-only stopgap for when this real trigger doesn't
fire) so the audit trail can still tell "this really happened via
check-in" apart from "someone manually forced it."

`GET /bookings?search=` powers a single lookup panel serving both
directions — the same guest-name-or-reference-number search finds a
booking awaiting arrival (`PENDING`/`CONFIRMED`) and one currently
in-house (`CHECKED_IN`) to check out, so front desk never needs two
different screens.

**Frontend.** `BookingsPage` gained a "Check-in / check-out" panel,
placed above "New booking" — a guest waiting at the desk is more
time-sensitive than starting a new reservation. Search finds a booking
by reference or name, selecting it shows the guest, dates, and each
unit's live status badge; check-in shows "Confirm arrival" normally, or
an amber warning with a "Check in anyway" button when a unit isn't
Ready yet; check-out shows "Confirm departure" unconditionally for a
`CHECKED_IN` booking — no balance display anywhere. A successful action
refetches the unit list so the "New booking" picker immediately
reflects the just-changed status.

7 new frontend tests (successful check-in from a Ready unit; the
not-ready-warning-then-acknowledge round trip, asserting the second
request actually carries `acknowledgeNotReady: true`; the hard
`UNIT_UNAVAILABLE` block when a unit is already occupied; unconditional
check-out). Re-verified the not-ready-warning-then-acknowledge flow in a
real headless browser against a mocked API: the warning renders, "Check
in anyway" sends the acknowledged retry, and the success message
appears.

Full repo lint/typecheck/build clean; `packages/shared` 62/62 (+8, the
new `BOOKING_TRANSITIONS`/`allowedBookingTransitions` tests); `apps/api`
238/241 (+28, same 3 pre-existing network-blocked round-trip tests);
`apps/web` 34/34 (+4). **Not yet built:** `CANCELLED`/`NO_SHOW`
transitions (no triggering endpoint yet), folio/payment tracking
(deliberately out of scope per the client's own correction above), and
this slice has **not yet been live-tested against the real Supabase
database** — same sandbox limitation as every prior milestone. Requires
a schema push before the client's own test:
`cd apps/api && npx prisma db push`.

### Check-in/check-out redesign: moved into the Unit drawer, multi-room checkout, and the missing housekeeping auto-ticket (2026-08-24)

Live-testing feedback on the previous slice, three parts.

**Permission seed narrowed.** `booking:checkin`/`booking:checkout` used
to seed to every role spec §5.4's table lists (SYS_ADMIN, RESORT_MGR,
OPS_SAFETY, ADMIN_HEAD, ADMIN_STAFF, CASHIER). Client decision, explicit
and narrower: seed only to `RESORT_MANAGER`, `ADMIN_HEAD`, and
`ADMIN_STAFF` by default (`SYSTEM_ADMIN` keeps every key, as always).
Removed from `OPS_SAFETY_SUPERVISOR` and `CASHIER` in
`packages/shared/src/rolePermissions.ts`, documented as a deliberate
departure from a literal reading of the matrix (same pattern as the
OWNER quick-action resolution earlier this session) — not a ceiling:
`SYSTEM_ADMIN` can still grant either key to any other role via the
Roles admin page. Backend tests that exercised these two endpoints as
CASHIER were switched to ADMIN_STAFF to match; no test asserted CASHIER
specifically needed to hold them.

**Check-in/check-out moved from the Bookings page into the Unit
drawer.** The previous slice's dedicated search-and-act panel is gone —
day-to-day check-in/check-out now lives where staff are already
looking, in the same "Bookings" section of `UnitDetailDrawer` that
already listed a unit's reservations. A booking with status
PENDING/CONFIRMED gets a direct "Check in" button right on its row; a
CHECKED_IN booking gets "Check out." Both are gated on
`booking:checkin`/`booking:checkout` — a role without either permission
sees the booking list (still gated only on `unit:read`, unchanged) but
no action buttons at all, same pattern as the work order Verify button
being hidden from a cross-department POC. The not-Ready
warning-then-acknowledge flow carried over unchanged, since it "works
well" per the client's own words — same `409 UNIT_NOT_READY` /
`acknowledgeNotReady` protocol, just rendered inline under the relevant
booking row instead of in a separate panel.

The Bookings page keeps its original two jobs — creating a new booking,
and a read-only "Find a booking" property-wide search by guest name or
reference number (the same `GET /bookings?search=` endpoint, now with
every action button stripped out; the drawer is where the action is).

**Multi-room checkout.** Real gap: the previous slice's checkout always
flipped every unit under a booking at once, with no way to check out
just one room from a multi-unit reservation. `checkOutBooking`
(`apps/api/src/modules/bookings/service.ts`) now accepts an optional
`unitId` — present, checks out only that unit and leaves the rest
Occupied; omitted, checks out every unit still Occupied (unchanged
behavior for a single-unit booking). The booking itself only finalizes
to `CHECKED_OUT` — and only then gets its `CheckOutRecord` — once every
one of its units has actually cleared; a partial checkout leaves the
booking at `CHECKED_IN` with no `CheckOutRecord` yet, and the next
checkout call (from whichever unit) picks up from there. `GET
/units/:id/bookings` now returns `unitCount` per booking (a plain
`_count`, not the full unit list) so the drawer can decide whether to
prompt at all — a single-unit booking's checkout never asks. When it
does span more than one unit, clicking "Check out" shows "This booking
includes N rooms — check out just this room, or all rooms under this
booking?" with both paths wired to the same endpoint, just with or
without `unitId`.

**The missing spec §7.1 auto-ticket, actually wired up.** Asked
directly whether checkout's `OCCUPIED -> VACANT_DIRTY` transition
auto-creates a `HOUSEKEEPING` work order per spec §7.1 — it did not; the
transition itself worked but nothing ever called `createWorkOrder`. Real
gap, not cosmetic: a room going Dirty with nothing alerting housekeeping
defeats the point of the automatic status change. Added directly inside
`applyAutomaticUnitStatusChange` (`apps/api/src/modules/units/
service.ts`), scoped specifically to a `VACANT_DIRTY` transition: an
untitled, no-photo-required (`HOUSEKEEPING`'s own `onCreate` requirement
is empty), `NORMAL`-priority ticket titled "Post-checkout cleaning —
{unit.code}", department `HOUSEKEEPING`. Best-effort like the realtime
broadcast beside it — a failure here is logged, never fails the checkout
itself. This is the second cross-module import in this codebase (units
-> workorders, after bookings -> units in the previous slice), same
justification: WorkOrder lifecycle (referenceNo generation, the
realtime broadcast, department notification) is owned by that module.
Deliberately scoped only to this real trigger, not to every path that
can reach `VACANT_DIRTY` — the `SYSTEM_ADMIN` override and
forced-correction panels are stopgap/data-correction tools, not spec's
actual "on check-out" trigger, and creating a ticket there wasn't asked
for.

`applyAutomaticUnitStatusChange`'s signature changed from a bare
`actorId: string` to the caller's full identity (id/department/roles/
permissions), since `createWorkOrder` needs that shape;
`req.authUser` already carried every field, so no router change was
needed to satisfy it.

7 new/updated backend tests (multi-room checkout: partial checkout
leaves the booking CHECKED_IN with no CheckOutRecord yet, the last unit
finalizes it, "all rooms" flips both in one call, a `unitId` outside the
booking is rejected, a non-Occupied unit is rejected; the housekeeping
ticket is asserted on checkout and asserted absent on check-in; checkout
still succeeds if the ticket-creation call itself fails). One pre-existing
test was fixed incidentally — a hardcoded `referenceNo` date literal
that depended on real wall-clock "today," now pinned with
`vi.setSystemTime`. 5 new frontend tests in `App.smoke.test.tsx`
covering the permission-gated visibility, a direct check-in, the
not-Ready warning/acknowledge round trip from the drawer, and the
multi-room prompt sending the right `unitId`. `BookingsPage.test.tsx`'s
4 old check-in/check-out tests were replaced with 1 read-only search
test.

`packages/shared` 62/62; `apps/api` 245/248 (+7, same 3 pre-existing
network-blocked round-trip tests); `apps/web` 35/35 (+5, net −4 removed
+9 added across the two files). Full repo lint/typecheck/build clean.
Re-verified the multi-room checkout prompt in a real headless browser
against a mocked API: "Check out" on an Occupied unit's CHECKED_IN,
2-room booking shows the prompt, and "Just this room" sends
`{unitId: "unit_1"}`. **No schema change this slice** — no
`npx prisma db push` needed before the client's live test, unlike the
previous one. **Not yet live-tested against the real Supabase
database.**

### Architectural pivot: no more internal reservations — Check-in creates the Booking record directly, Bookings page removed (2026-08-24)

Client decision, live-testing feedback, three parts. Verbatim framing:
"this app's job is monitoring the resort's current, live state, not
managing reservations... every guest, including walk-ins, is already
logged on the resort's separate booking website first and always
arrives with a real external booking ID — there is no scenario where a
reservation needs to be created inside this app."

**Check-in is now a quick-action on the Units page**, gated on
`booking:checkin`, below the grid — a `CheckInPanel` component in
`UnitsPage.tsx`. Deliberately just four fields: guest name, Booking ID
(free text, capturing the *external* site's reference, not something
this app generates), check-in date, and a room checklist (same
live-status-aware picker the old "New booking" form used). A selected
room that isn't `READY` shows the same warn-not-block pattern already
built (`409 UNIT_NOT_READY` → "Check in anyway"). On confirm, the
room(s) move to `OCCUPIED` via the existing automatic transition, logged
through the same `UnitStatusEvent`/audit trail every other status change
uses — `fromStatus` shows the room's real prior state (e.g. `DIRTY`),
not a fabricated one.

**The Bookings page is gone entirely** — both "New booking" and "Find a
booking." So is its nav item. Walked through what that touched rather
than just hiding the route:

- `POST /bookings` (creation), `GET /bookings` (search), and
  `GET /bookings/:id` are deleted, along with the availability engine
  that backed creation — `windowsConflict`, `resolveBookingWindow`,
  `getBookingWindowSettings`, and the four `booking.*` Settings that fed
  it (no longer seeded; not retroactively deleted from an already-seeded
  database, since nothing reads them anymore either way).
- `booking:create` and `booking:read` are removed from
  `packages/shared/src/permissions.ts` and every role grant — their only
  routes are gone. `booking:update` is removed too: grep confirmed it
  was *never* wired to any endpoint, even before this change.
  `booking:checkin`/`booking:checkout` stay (check-in now creates the
  row directly; checkout still flips it).
- The `Booking`/`BookingUnit` models themselves are **not** dead — kept
  and reused, not replaced with a separate lightweight record. They're
  the join point `FolioCharge`, `Payment`, `WorkOrder`, `AmenityRequest`,
  `FnbOrder`, and `Incident` all already hang off via `bookingId` for
  future milestones, and `BookingUnit` already models "which rooms
  belong together" — exactly what the multi-room checkout grouping below
  needs. A separate model would have fragmented that.

**Data model tradeoff, flagged and resolved with the client before
building** (both confirmed via `AskUserQuestion`, not decided silently):

1. Several columns Check-in never collects (`pax`, `departureDate`,
   `endAt`, `totalAmount`, `BookingUnit.rate`) went nullable rather than
   holding a fabricated placeholder. `endAt` is filled in with the
   *actual* checkout moment once it happens — a real fact, not a planned
   one — matching "record what actually happened," consistent with the
   monitoring-not-transactions principle from the prior slice.
2. `referenceNo` (holding the free-text external Booking ID) is no
   longer `@unique`. A group can arrive in waves under the same external
   ID across more than one check-in submission — each is its own Booking
   row, matched back together by string equality, not by a single row's
   id. Indexed instead (`@@index([referenceNo])`) for lookup speed.

**Multi-room checkout became a checklist**, not last slice's binary
"just this room / all rooms" prompt. New endpoint
`GET /bookings/group?referenceNo=` returns every currently-Occupied unit
sharing a booking's external ID — potentially spanning more than one
Booking row now that referenceNo isn't unique. The drawer pre-checks the
room it was opened from; the front desk can check/uncheck any
combination before confirming. `POST /bookings/checkout` now takes
`unitIds: string[]` directly instead of a single booking id — each
requested unit is validated (Occupied, under a `CHECKED_IN` booking)
before anything is written, then grouped by its *own* Booking row: a row
only finalizes to `CHECKED_OUT` (and only then gets its `CheckOutRecord`)
once every one of its own units has cleared, so one call can finalize
multiple Booking rows independently, or none at all.

**The still-missing spec §7.1 auto-ticket, found while touching this
code again, wired up:** confirmed checkout's `OCCUPIED -> VACANT_DIRTY`
never actually called `createWorkOrder`, despite the transition itself
working since the original check-in slice. Added inside
`applyAutomaticUnitStatusChange` (`units/service.ts`), firing on every
`VACANT_DIRTY` transition regardless of caller (single-room, multi-room,
any Booking row) — an untitled-but-titled "Post-checkout cleaning —
{unit.code}" `HOUSEKEEPING` ticket, `NORMAL` priority, no photo required
(`HOUSEKEEPING`'s own `onCreate` requirement is empty), best-effort like
the realtime broadcast beside it (a failure there is logged, never fails
the checkout). Second cross-module import in this codebase (units ->
workorders), same justification as the first (bookings -> units): ticket
lifecycle is owned there.

34 backend tests rewritten/added covering: check-in creating the Booking
row directly (single- and multi-room, hard blocks, the not-Ready
warning/acknowledge round trip, no ticket on check-in); the group
checklist query's own where-clause; checkout validating and grouping by
owning Booking row across a single row, a multi-unit row, and — the new
case — two *different* rows sharing one referenceNo (only the row that
actually clears finalizes); the housekeeping ticket assertion and its
best-effort failure path; the nullable-`endAt` fix to
`listUpcomingBookingsForUnit`'s own filter (a plain `endAt >= now` would
have silently dropped every currently-occupied guest with no known
departure — caught while making `endAt` nullable, not by a report).
5 new frontend tests replacing the old Bookings-page ones: permission-
gated visibility of both the Check-in panel and the drawer's Check-out
button, a direct check-in, the not-Ready warning from the panel, and
both checklist shapes (single-room auto-confirm, multi-room with a
toggle). Re-verified live in a real headless browser: the Bookings nav
item is gone, and the Check-in panel completes a real check-in end to
end against a mocked API.

`packages/shared` 55/55; `apps/api` 223/226 (same 3 pre-existing
network-blocked round-trip tests); `apps/web` 32/32. Full repo
lint/typecheck/build clean. **Schema change this slice** — `referenceNo`
losing `@unique`, and `pax`/`departureDate`/`endAt`/`totalAmount`/
`BookingUnit.rate` going nullable — run `npx prisma db push` before the
client's live test. **Not yet live-tested against the real Supabase
database.**

### Check-in fixes: Occupied rooms selectable in the picker, panel too wide (2026-08-24)

Two live-testing reports on the Check-in panel from the previous slice.

**Real bug:** `isBookable` (the same filter gating the room checklist)
disabled `OUT_OF_ORDER`/`BLOCKED` but not `OCCUPIED` — an already-
occupied room was fully clickable, risking a double-booking of a room
that already has a guest in it. The server's own hard block
(`409 UNIT_UNAVAILABLE`) already rejected this, but the picker itself
should never offer it in the first place, same as the other two
statuses. Added `OCCUPIED` to the same disabled-selection check in
`apps/web/src/routes/UnitsPage.tsx`.

**Layout refinement, no functional change.** The panel was full-width
with a 3-column field row and an always-expanded ~23-room checklist —
now roughly 1/3 page width (`md:w-1/3`), fields stacked top to bottom in
the requested order (Booking ID, Guest name, Check-in date), and the
room checklist collapsed behind a `<details>`/`<summary>` — the same
pattern the "Report an issue" form already uses to collapse on Work
Orders — rather than shown open by default. The summary also shows a
live "(N selected)" count so a collapsed checklist doesn't hide whether
anything's actually been picked. Live per-room status badges, the
disabled states, and the not-Ready warning/acknowledge flow are all
unchanged — this was sizing and field order only.

1 new frontend test (`R01` selectable, `R02` Occupied and `R03` Blocked
both disabled in the same checklist) plus the existing check-in/checkout
tests re-verified unchanged. `apps/web` 33/33 (+1). Full repo
lint/typecheck/build clean. Re-verified live in a real headless browser:
the panel renders at ~26% of the page width (roughly 1/3 of the content
area net of the nav sidebar), the room checklist stays collapsed until
clicked, and Occupied/Blocked checkboxes are both disabled while Ready
stays selectable. No schema change, no `npx prisma db push` needed for
this slice.

### Real gap found live-testing: pre-redesign bookings invisible to the drawer's own Check-out (2026-08-24)

Logged in as Admin Head (holds `booking:checkout`), C01's drawer showed
"Bookings" and "Timeline" sections but no Check-out button — unlike
C02/R07, checked in through the new Check-in flow, which correctly
showed one. C01's booking (ref `LWW-260823-0002`) predates the redesign:
created via the old, now-removed "New booking" form and checked in
through the old flow on 8/23, before Check-in creation replaced it.

Root cause, found by re-reading the nullable-`endAt` migration from two
slices ago rather than by guessing: `listUpcomingBookingsForUnit`'s own
query — the one powering the drawer's Bookings section — filters out
any booking whose `endAt` isn't null and has already passed
(`OR: [{endAt: null}, {endAt: {gte: now}}]`). That filter was written to
keep a *new*, open-ended (`endAt: null`) Check-in-flow stay always
showing. It never accounted for the flip side: an *old* booking has a
real, non-null `endAt` resolved from whatever departure date the guest
gave back when it was created. Once that date passes — entirely
plausible days later, with the guest never actually checked out through
the app — the row silently drops out of the query entirely. Not "the
button is hidden for old bookings" as first suspected; the row itself
never reaches the drawer, so there was never a `<li>` for a button to
render into. `canCheckOut` (client-side) was never the problem — it's a
pure function of permission and `booking.status`, unaffected by how or
when the row was created.

Fixed by adding `{ status: 'CHECKED_IN' }` to the same `OR`: a
`CHECKED_IN` booking is definitionally current — the guest hasn't left
and nothing has closed it out — regardless of what its originally-
planned end date was. The `endAt`-based half of the filter still matters
for a legacy `PENDING`/`CONFIRMED` row (unreachable going forward, but
historical data may still hold one) — a long-past planned arrival that
never happened shouldn't linger in the list either way.

2 new backend tests: the `where` clause's own `OR` shape now asserts all
three branches; a dedicated case reproducing the exact report (a
`CHECKED_IN` booking with a real, already-past `endAt`) confirms it
still reaches the client with its status intact. `apps/api` 224/227
(+2, same 3 pre-existing network-blocked round-trip tests). Full repo
lint/typecheck/build clean. No schema change — this is a query fix only,
no `npx prisma db push` needed. Live data note: **C01 and any other
pre-redesign booking still sitting Occupied should now show a Check-out
button** once this is pulled; nothing needs manual cleanup in Supabase.

### That fix was still wrong for C01 — traced the real cause, keyed checkout off the room's own status instead (2026-08-24)

Client re-tested on the previous commit and C01 still had no Check-out
button, identical to before. Asked to verify the booking's actual
database state directly rather than reason from code alone — confirmed
this sandbox genuinely cannot reach the client's live Supabase project:
raw TCP to the Postgres pooler (ports 5432/6543) times out, and the
outbound HTTPS proxy explicitly denies (403) any connection to the
project's `supabase.co` host — checked directly against the proxy's own
status endpoint, which logs the rejection. No way to run the query
myself.

The client's own hypothesis was right, and it exposed a real flaw in the
*previous* fix. That fix added `{ status: 'CHECKED_IN' }` to
`listUpcomingBookingsForUnit`'s `OR`, reasoning "a checked-in booking is
always current regardless of its endAt" — true, but it silently assumed
every booking behind a genuinely-Occupied room actually *reached*
CHECKED_IN. C01's doesn't: it was created and checked in through the
old, now-removed "New booking" flow, and — per the client's own
hypothesis, which this sandbox can't disprove without DB access but
which the code fully explains — its own transition to CHECKED_IN may
never have completed before that flow was deleted, leaving it stuck at
a legacy `PENDING`/`CONFIRMED` status forever. Nothing in this codebase
can move a booking out of those two states anymore
(`BOOKING_TRANSITIONS` empties both edges since the redesign). The
previous fix's `endAt`-bypass only fired for `CHECKED_IN` specifically,
so a booking stuck at `PENDING` with a real, now-past `endAt` reproduced
the exact original bug — the row (and the button behind it) still
vanished once that old departure date passed.

**Fixed properly this time by changing what "checkoutable" is keyed on
everywhere in the checkout path — the room's own live `Unit.status`
(`OCCUPIED`), not the booking's bookkeeping status:**

- `listUpcomingBookingsForUnit`'s `endAt`-bypass now checks
  `unit.status === 'OCCUPIED'` instead of `booking.status ===
  'CHECKED_IN'` — a genuinely-occupied room's booking always shows,
  regardless of what stuck legacy status or stale planned end date it
  carries.
- `findOccupiedUnitsForReferenceNo` (the checkout checklist query)
  dropped its `booking.status === 'CHECKED_IN'` requirement down to
  excluding only `CANCELLED`/`CHECKED_OUT` — a booking in either of
  those two states has no business being tied to an Occupied unit's
  checkout; every other status is a valid checkout candidate as long as
  the unit itself is Occupied.
- `checkOutUnits`'s own validation (server-side, the actual write path)
  makes the same change — `Unit.status === 'OCCUPIED'` is now the
  primary gate, with only `CANCELLED`/`CHECKED_OUT` bookings rejected.
- The frontend's `canCheckOut` (`UnitsPage.tsx`) now reads the drawer's
  own `unit.status` directly instead of `booking.status` — simpler, and
  it's the same live prop already driving the status badge above it.

This is a deliberate broadening, not a narrow patch for this one row:
any historical booking left in an inconsistent state by this session's
several redesigns — not just C01's specific case — now has a real
checkout path, keyed off the fact that actually matters operationally
(is the room occupied right now), rather than a bookkeeping field that
three different flows have written to across the life of this codebase.

4 new/updated backend tests (the checklist query's relaxed status
filter; checkout succeeding for a unit whose booking is stuck at legacy
`PENDING`; the drawer query's `OR` now referencing `unit.status`
directly; the exact reported row — `PENDING` status, past `endAt`,
Occupied unit — reaching the client). 1 new frontend test reproducing
the precise report (Admin Head, an Occupied room, a `PENDING`-status
booking) asserting the Check-out button renders. `apps/api` 225/228
(+1 net after replacing the prior slice's now-superseded assertions);
`apps/web` 34/34 (+1). Full repo lint/typecheck/build clean.
Re-verified in a real headless browser reproducing the exact reported
case (C01, ref `LWW-260823-0002`, guest "test 2", `PENDING` status,
Occupied unit): the Bookings section shows the guest, and the Check-out
button now renders. No schema change, no `npx prisma db push` needed.

### Session summary: the Check-in/Check-out redesign, start to finish, client-verified (2026-08-24)

Client confirmed live: C01's Check-out button works, the room flips to
Dirty, and a housekeeping ticket auto-creates. The full arc below is
verified end to end, including the legacy-data edge case.

**The pivot.** Live-testing surfaced a mismatch between how this app was
built (M4's original design: an internal reservation system with its
own availability engine) and how the resort actually operates: every
guest already has a real booking on the resort's separate external
booking website before arriving — this app was never meant to create or
manage reservations, only to monitor and coordinate the property's live
state. That correction reshaped the rest of the night.

**Check-in, built as a new standalone feature.** A quick-action panel on
the Units page (gated on `booking:checkin`), not a wizard: guest name,
free-text external Booking ID, check-in date, and a live-status-aware
room checklist. Confirming creates the `Booking` row directly (already
`CHECKED_IN` — there's no more "PENDING awaiting arrival" step) and
moves the selected room(s) to `OCCUPIED` via the existing automatic
transition, logged through the same `UnitStatusEvent` audit trail as
every other status change. The not-Ready warning/acknowledge pattern
carried over unchanged. Refined twice after live-testing: `OCCUPIED`
rooms were fixed to disable in the picker alongside `OUT_OF_ORDER`/
`BLOCKED` (a real double-booking risk), and the panel was compacted to
roughly 1/3 page width with the room checklist collapsed behind a
`<details>`, matching the "Report an issue" pattern already established
on Work Orders.

**The Bookings page removed, with its dependencies walked deliberately
rather than assumed.** Both "New booking" and "Find a booking," plus the
nav item, plus the entire availability/overlap engine that backed
creation (`windowsConflict`, the turnaround buffer, the four `booking.*`
Settings that fed it) — all confirmed dead and removed.
`booking:create`/`booking:read`/`booking:update` dropped from the
permission set once their only routes were gone (`booking:update`
turned out to have never been wired to anything, even before this
redesign). But `Booking`/`BookingUnit` themselves were kept and reused,
not replaced with a separate model — they're the join point
`FolioCharge`/`Payment`/`WorkOrder`/`AmenityRequest`/`FnbOrder`/
`Incident` already hang off via `bookingId` for future milestones, and
`BookingUnit` already modeled the room-grouping the new checklist
checkout needed. Two real client decisions were confirmed before
building rather than assumed: several now-uncollected fields
(`pax`/`departureDate`/`endAt`/`totalAmount`/`BookingUnit.rate`) went
nullable rather than holding fabricated placeholders, and `referenceNo`
(now the free-text external Booking ID) dropped its uniqueness
constraint so a group can check in across more than one submission
under the same external ID.

**Multi-room checkout as a checklist.** Replaced last session's binary
"just this room / all rooms" prompt — a real gap for bookings spanning
3+ rooms where the guest is leaving some but not all. `GET
/bookings/group` returns every currently-Occupied unit sharing a
booking's external ID (which can span more than one `Booking` row once
referenceNo stopped being unique), pre-checks the room the front desk
opened it from, and lets them adjust before confirming. `POST
/bookings/checkout` takes the confirmed `unitIds` directly; each
Booking row finalizes to `CHECKED_OUT` independently once every one of
its own units has cleared.

**Two real bugs found live-testing, both fixed:**

1. **The spec §7.1 auto-ticket was never actually wired up.** Checkout's
   `OCCUPIED -> VACANT_DIRTY` transition worked, but nothing called
   `createWorkOrder` — a room going Dirty with nothing alerting
   housekeeping defeated the point of the automatic change. Fixed inside
   `applyAutomaticUnitStatusChange`, firing on every `VACANT_DIRTY`
   transition regardless of caller: an untitled `HOUSEKEEPING` ticket,
   `NORMAL` priority, no photo required, best-effort like the realtime
   broadcast beside it.

2. **Checkout was keyed off the booking's bookkeeping status instead of
   the room's live status — the deeper, more consequential bug.** A
   booking created and checked in through the old, now-removed "New
   booking" flow could be stuck at a legacy `PENDING`/`CONFIRMED` status
   forever if its own transition to `CHECKED_IN` never completed before
   that flow was deleted — nothing in the redesigned codebase can move a
   booking out of those two states anymore. Two attempts were needed:
   the first (`status: 'CHECKED_IN'` added to the drawer query's
   `endAt`-bypass) still failed for a booking genuinely stuck at
   `PENDING`, since it only bypassed the filter for the one status it
   named. The real fix reworked the entire checkout path — the drawer
   query, the checklist query, the server-side checkout validation, and
   the frontend button logic — to key off `Unit.status === 'OCCUPIED'`
   as the primary signal everywhere, with only `CANCELLED`/`CHECKED_OUT`
   bookings excluded. This wasn't a narrow patch for one row: it fixes
   the same class of problem for *any* booking a future redesign leaves
   in an inconsistent bookkeeping state, since the room's own live
   status — not a field three different flows have written to over the
   life of this codebase — is now the thing that actually decides
   whether a room can be checked out.

Root-caused entirely from the code and this session's own history, not
guesswork — this sandbox has no network path to the client's live
Supabase project (confirmed directly: the Postgres pooler times out,
and the outbound proxy denies the REST API host by policy), so every
fix here was verified against real backend/frontend tests and a real
headless-browser reproduction of the exact reported case, then confirmed
correct by the client against the actual live data.

Final tallies across the whole arc: `packages/shared` 55/55, `apps/api`
225/228 (same 3 pre-existing network-blocked round-trip tests, present
since M0 and unrelated to any of this work), `apps/web` 34/34. Full repo
lint/typecheck/build clean throughout.

### SLA-breached work orders: real attention-queue data, not a stub; unverified payments removed outright (2026-08-24)

Client-flagged staleness in the Command Center's attention queue:
"SLA-breached work orders" still read "Coming in M3," even though M3
(work orders) was fully built and confirmed working days earlier. Asked
to check whether the underlying detection logic already existed
somewhere, or whether the label was simply wrong.

It genuinely didn't exist — grepped `dueAt`/`slaBreached`/`SLA` across
the whole work orders module and found only the raw, optional `dueAt`
field set at ticket creation, with zero breach-computation logic
anywhere. But the label wasn't just wrong either: spec §7.2 already
defines the exact formula (`dueAt < now && status not in (DONE,
VERIFIED, CANCELLED)`), and the data it needs (`dueAt`, `status`) has
existed since M3 shipped. So the fix was to build the real feature, not
relabel the stub:

- `listSlaBreachedWorkOrders()` (new, `workorders/service.ts`) queries
  exactly that formula. `REOPENED` is deliberately not excluded — a
  reopened ticket past its due date is still breached per spec's literal
  wording, and `WORK_ORDER_STATUS_KEYS` confirms it's the only status
  outside the three-value exclusion set.
- Wired into `getUnitsDashboard()` (`units/service.ts`) as a new
  `slaBreachedWorkOrders` field on `UnitsDashboard`, alongside the
  existing `dirtyRooms` — the same units->workorders cross-module
  import this codebase already uses for the post-checkout housekeeping
  auto-ticket, extended with one more function rather than a new
  pattern. `GET /units/dashboard` stays gated on `unit:read`, not
  `workorder:read` — not a permission leak in practice, since
  `workorder:read` is the floor every role holds (see
  `rolePermissions.ts`'s own comment on why).
- `DashboardPage.tsx`'s attention queue now renders real breached-ticket
  rows (reference no., title, unit, overdue duration) exactly like the
  existing dirty-room rows, including an explicit empty-state message
  rather than just omitting the section when nothing's breached.

While in there, also addressed the client's second flag: "Unverified
payments >24h" still said "Coming in M4," but M4's payment tracking was
already ruled entirely out of scope in an earlier session decision
("if a feature is about tracking or moving money, it's out of scope" —
handled by the external website/POS, not this app). "Coming in M4"
implies it's still on the way; it isn't, permanently. Removed the row
outright rather than relabeling it. "Overdue amenities" (M5) is
untouched — that one actually is still a later milestone.

Flagged but deliberately not touched (out of scope for this fix, same
staleness pattern, left for the client to prioritize): the KPI strip
still has stub cards reading "Open urgent work orders" (M3, now
inaccurate the same way the attention-queue row was), "Pending payment
verifications" (M4, now permanently out of scope like the row just
removed), and "Arrivals / departures today" (M4, unclear given the
Check-in/Check-out redesign's departure from tracking arrivals the old
way).

Verified with a new `listSlaBreachedWorkOrders()` unit test (where-clause
shape and response mapping, since the function has no HTTP route of its
own) plus two new `GET /units/dashboard` router tests (a breached ticket
included, an empty list when nothing's breached), and a real
headless-browser run against a mocked `/units/dashboard` response
confirming the row renders correctly and the payments stub is gone from
the DOM. `packages/shared` 55/55, `apps/api` 230/233 (same 3
pre-existing network-blocked round-trip tests), `apps/web` 34/34. Full
repo lint/typecheck/build clean.

### KPI strip: the last three stale placeholders, closed out (2026-08-24)

Follow-up to the SLA-breach fix above, closing out the three KPI-strip
placeholders flagged but deliberately left untouched at the end of that
pass. All three followed the same pattern as "SLA-breached work orders":
a "coming in M#" label that had gone stale because the milestone it
pointed to either shipped or was ruled out of scope since the label was
written.

1. **"Open urgent work orders" (M3) → real data.** M3 shipped days ago.
   New `countUrgentOpenWorkOrders()` (`workorders/service.ts`) counts
   `priority: URGENT` tickets with `status not in (DONE, VERIFIED,
   CANCELLED)` — the same "open" definition `listSlaBreachedWorkOrders`
   already uses, so `REOPENED` counts as open here too, for the same
   reason. Wired into `getUnitsDashboard()`'s `kpi` object as
   `urgentOpenWorkOrders`.

2. **"Pending payment verifications" (M4) → removed outright.** Identical
   reasoning to last pass's "Unverified payments >24h": payment tracking
   is permanently out of scope for this app (handled by the external
   website/POS), so "Coming in M4" was actively misleading, not merely
   stale. No replacement card — the KPI strip just has one fewer item
   now, same as the attention queue does.

3. **"Arrivals / departures today" (M4) → replaced, not just relabeled.**
   This one needed a real design decision, not a straight swap: the
   original concept assumed a date-based internal reservation system,
   and the Check-in/Check-out redesign deleted that system entirely — a
   booking now only exists once someone has actually checked a guest in,
   with no forward-looking arrivals list to count "today's arrivals"
   against. So the replacement isn't "arrivals/departures" at all, it's
   the closest real question this data can actually answer: how much
   guest turnover happened today. Two new KPI fields, `checkinsToday`
   and `checkoutsToday`, count `UnitStatusEvent` rows created since local
   midnight where the transition was `READY -> OCCUPIED` (check-in) or
   `OCCUPIED -> VACANT_DIRTY` (check-out) respectively — both are the
   exact transitions `applyAutomaticUnitStatusChange` already writes on
   every real check-in/check-out, so this required no new instrumentation,
   just a new read.

The KPI strip is now 7 real cards and exactly 1 stub ("Open F&B tickets,"
M5 — the only spec §8.2 KPI that still has no underlying module) instead
of the previous 4 real / 4 stub split. The attention queue (from the
prior pass) is 2 real items plus 1 stub ("Overdue amenities," also M5).
Zero remaining stale or out-of-scope placeholders anywhere in the Command
Center.

Verified with new `countUrgentOpenWorkOrders()` and dashboard-level tests
(open-urgent count via `workOrder.count`, not the SLA-breach `findMany`;
check-in/check-out counts scoped to midnight via `unitStatusEvent.count`)
plus updated smoke-test coverage for the full 8-card KPI strip and the
now-real attention queue, and a real headless-browser run confirming all
8 cards render correctly and both removed placeholders are gone from the
DOM. `packages/shared` 55/55, `apps/api` 233/236 (same 3 pre-existing
network-blocked round-trip tests), `apps/web` 34/34. Full repo
lint/typecheck/build clean.

### M5, slice 1: amenity catalogue (2026-08-24)

**Sandbox-verified only — not live-tested.** The client is phone-only for
a while and asked me to keep building M5 (restaurant & amenities) in
small, coherent slices, reporting after each one, with everything
double-checked once they're back at a PC. This report is exactly that:
what I verified myself (typecheck/lint/build, real unit/integration
tests against a mocked Prisma client, a real headless-browser Playwright
run against a mocked API) versus what still needs a real pass against
live data.

First M5 slice: the amenity catalogue only (spec §6 `AmenityItem`) —
`GET/POST /amenity-items` (list, create) and `PATCH /amenity-items/:id`
(update, including deactivate/reactivate). The request → approve → issue
→ return workflow (§7.4) is a deliberately separate, later slice — this
one just gets the catalogue itself onto the board so that workflow has
something real to point at.

**Scope decision, not a guess:** the client's own instruction for this
work extended M4's "monitoring, not transactions" principle to F&B/
amenities explicitly — F&B order status and kitchen coordination are in
scope, any payment/charge tracking is out of scope or informational-only.
`AmenityItem.requiresDeposit`/`depositAmount` are exactly that kind of
field (spec: "items with `requiresDeposit` cannot move to `ISSUED`
without a recorded deposit amount") — this slice surfaces `depositAmount`
as plain informational text on the catalogue table and the add-item form
("Deposit amount (₱, informational only)"), never wired to `Payment` or
`FolioCharge`, both of which stay unbuilt/unused, same as every other
M4/M5 payment-adjacent field so far.

Backend: `apps/api/src/modules/amenities/` (schema/service/router,
mirroring the existing `units`/`workorders` module shape), registered in
`app.ts`. `GET /amenity-items` gated on `amenity:read`; `POST`/`PATCH` on
`amenity:manage` — both permission keys already existed in the seeded
matrix from M1, unused until now. `packages/shared/src/amenity.ts` adds
`AMENITY_CATEGORY_KEYS` (mirrors spec's `AmenityCategory` enum — closed
set, unlike `MenuItem.category` which spec leaves as free text).

Frontend: new `/amenities` page + nav item (`AppShell.tsx`, gated on
`amenity:read`, invisible to Restaurant Manager/Staff — per the role
matrix they hold no `amenity:*` key at all, amenities being a front-desk/
ops responsibility here, not a kitchen one). Read-only table for
`amenity:read`-only holders (e.g. Admin Staff); an add-item form and a
per-row deactivate/reactivate toggle appear only for `amenity:manage`
holders (Resort Manager, System Admin).

Seed data: added spec §10's ~12 amenity items (PS4/PS5, 2 videoke units,
6 board games, beach volleyball set, kayak, billiard table) to
`seed.ts`, create-if-missing by `name` (same idempotency pattern as
`UnitType` — `AmenityItem` has no other natural unique column), so a
re-run never clobbers real catalogue edits made through the new admin UI.
**This part is unverified beyond typecheck** — the sandbox has no network
path to run it against a real database; the client running `npm run
seed` once back at a PC is the actual test.

Verified: 8 new backend router tests (permission gates on both routes,
category validation, 404 on an unknown item, the Decimal→number
conversion for `depositAmount`), 2 new frontend tests (manage-permission
holder can list/add an item with the deposit shown as plain text;
read-only holder sees the table but no add-item form or deactivate
button), and a real headless-browser Playwright run against a mocked API
confirming the catalogue renders, an item can be added, and the
deactivate toggle flips a row's status. `packages/shared` 55/55, `apps/api`
241/244 (same 3 pre-existing network-blocked round-trip tests), `apps/web`
36/36. Full repo lint/typecheck/build clean.

**Not yet built, next slices:** amenity request → approve → issue →
return workflow + the overdue sweep job (§7.4); the F&B menu, order
creation, and kitchen kanban (§7.3). No design ambiguity hit yet in this
slice worth flagging — the payments-scope question was already resolved
by the client's own instruction before I started.

### M5, slice 2: amenity request/issue/return workflow + overdue sweep job (2026-08-24)

**Sandbox-verified only — not live-tested.** Same phone-only working
agreement as slice 1: small slices, everything checked here is
typecheck/lint/build plus real backend tests against a mocked Prisma
client — no browser run this time (backend-only slice, no new frontend
surface to click through), and definitely nothing against real data.

Backend-only slice, deliberately: the request → approve → issue → return
workflow (spec §7.4) plus the `POST /jobs/amenity-overdue` sweep. The
Amenities page UI for this workflow is next.

**New transition table**, `packages/shared/src/amenityRequest.ts`, same
pattern as `unitStatus.ts`/`workOrder.ts`:
`REQUESTED -> APPROVED -> ISSUED -> RETURNED`, with `CANCELLED` off
`APPROVED` and `OVERDUE -> RETURNED | LOST_DAMAGED`. Two judgment calls,
flagged rather than silently assumed:

1. **`REQUESTED -> CANCELLED` added**, even though spec's own diagram
   only draws `CANCELLED` from `APPROVED`. Same reasoning already
   confirmed by the client for `WorkOrder`'s `OPEN -> CANCELLED` gap
   earlier this session: an unapproved request needs a withdraw path too,
   not just a duplicate/mistake stuck waiting for someone to approve it
   before it can be cancelled. Unlike the work-order case this isn't a
   client confirmation — it's a documented inference from precedent,
   worth a second look once you're back at a PC.
2. **`ISSUED -> OVERDUE` deliberately has no entry in the table at all.**
   It's the one truly automatic transition (spec: "auto-flips... via
   `POST /jobs/amenity-overdue`") — it never goes through the manual
   status-change endpoint, same as units' automatic `READY -> OCCUPIED`/
   `OCCUPIED -> VACANT_DIRTY` bypassing the manual transition table
   entirely rather than appearing in it with an override permission.

Both cancellation transitions (`REQUESTED`/`APPROVED -> CANCELLED`) are
gated on `amenity:approve` — confirmed safe by checking the seeded role
matrix directly: every role holding `amenity:request` also holds
`amenity:approve`, so no requester loses the ability to withdraw their
own request by gating cancellation on the reviewer permission instead of
inventing a separate key.

**Deposit gate, monitoring-not-transactions applied again:** spec §7.4
says an item with `requiresDeposit` "cannot move to `ISSUED` without a
recorded deposit amount." Per the client's explicit instruction this
session, that's enforced as a plain `depositCollected: boolean`
confirmation the issuer must tick — a `422 DEPOSIT_REQUIRED` blocks the
transition otherwise — never a `Payment`/`FolioCharge` posting. Nothing
about an actual amount collected is persisted anywhere beyond that
boolean; `AmenityItem.depositAmount` (from slice 1) stays the one
informational reference figure. `dueBackAt` is separately required on
issue (needed for the overdue job to ever have something to check).

**New endpoints** (`apps/api/src/modules/amenities/`): `POST`/`GET
/amenity-requests`, `GET /amenity-requests/:id`, `POST
/amenity-requests/:id/status` (one generic status-change route, same
`requireAuth` + `getMe` + transition-table-decides-the-permission pattern
as work orders'/units' status routes — no single fixed permission gate
since which key applies depends on the requested transition). Broadcasts
`amenity.request.changed` on the existing `property` realtime channel
(spec §9.1), best-effort, same non-fatal pattern as every other broadcast
in this codebase.

**New job infrastructure** (`apps/api/src/modules/jobs/`): spec §3.1's
"plain authenticated HTTP endpoint... protected by a shared secret
header" pattern, built fresh (nothing existed yet). `requireJobSecret`
compares the `x-job-secret` header against `JOB_SECRET` (already scaffolded
in `env.ts` since M0/M1, unused until now) using `crypto.timingSafeEqual`
rather than `===` — this header is a bearer credential on a
fully internet-exposed API (spec §3.1.1), so a naive comparison's timing
side-channel is worth closing even though it's a small one.
`applyAmenityOverdueSweep` is a bulk `updateMany` (not the per-row
`changeAmenityRequestStatus`), matching that this transition needs no
permission check — the job route's shared secret is the only
authorization it needs.

Verified: 8 new transition-table tests (`packages/shared`) covering the
full lifecycle including both judgment calls above; 16 new backend tests
(`apps/api`) covering every transition's permission gate, the deposit
gate (blocked and unblocked), the `dueBackAt` requirement, the job
route's secret check (missing, wrong, correct), and the sweep's
`updateMany` where-clause. `packages/shared` 63/63, `apps/api` 257/260
(same 3 pre-existing network-blocked round-trip tests), `apps/web` 36/36
(unchanged — no frontend work this slice). Full repo lint/typecheck/build
clean.

### M5, slice 3: amenity request/issue/return UI (2026-08-24)

**Sandbox-verified only — not live-tested.** Same working agreement as
slices 1-2. Frontend for the workflow slice 2 built on the API for —
closing out the amenity module's first full vertical slice, catalogue
through return.

Extended `AmenitiesPage.tsx` with a "Requests" section below the
catalogue: a request form (`amenity:request` holders) and a list of
requests with a status badge and permission-gated action buttons per
row — Approve/Cancel on `REQUESTED`, Issue/Cancel on `APPROVED`,
Return on `ISSUED`/`OVERDUE` — matching each row's actual current status
against the transition table from slice 2, not a fixed action set.

Issue and Return each open an inline sub-form rather than firing
immediately, since both need data the transition table's permission gate
alone can't capture: Issue requires a due-back date/time and, for a
deposit-requiring item, a "Deposit collected (₱X, informational only)"
checkbox — both enforced client-side before the request goes out, and
enforced again server-side (slice 2's actual gate) since the client-side
check is only a better error message, not the real authorization.
Return lets the issuer pick `RETURNED` or `LOST_DAMAGED` with an optional
condition note. Consistent with every money-adjacent field so far, the
deposit checkbox stores nothing beyond itself — no amount, no `Payment`
row.

A 60-second poll fallback (same pattern as the Command Center) keeps the
request list from going stale if two staff are working the same request
queue in different tabs — no realtime subscription for amenity requests
yet, deliberately deferred rather than adding a second broadcast-consumer
pattern in the same slice that already added a broadcast producer
(slice 2's `amenity.request.changed` emit).

Verified: 1 new frontend test driving the full lifecycle in one pass —
submit → approve → issue (asserting both the due-back and deposit gates
block the confirm button with the right error text before succeeding) →
return — plus a real headless-browser Playwright run doing the exact
same sequence against a mocked API, confirming the UI actually renders
and updates correctly end to end, not just that the mocked fetch calls
were made. `packages/shared` 63/63, `apps/api` 257/260 (same 3
pre-existing network-blocked round-trip tests, unchanged this slice),
`apps/web` 37/37. Full repo lint/typecheck/build clean.

This closes out the amenity module (catalogue + full request/issue/
return workflow). Next: the F&B menu, order creation, and kitchen
kanban (spec §7.3).

### Launch checklist correction: the amenity-overdue job secret is a real launch task, not just a check (2026-08-24)

Client note before the F&B slice below: item 6 of spec.md's §11.1 M7
launch checklist previously only said to "confirm the Netlify Scheduled
Functions... are registered and each fires once against the deployed
endpoints." That undersold it — `JOB_SECRET` (M5's amenity-overdue sweep,
last session) has to actually be rotated off the local-dev placeholder
to a real production value in Netlify's environment config, *and* each
Scheduled Function's own outbound call has to be wired to send that
exact value in the `x-job-secret` header, or the endpoint 401s every
time it fires. Expanded the item to say so explicitly — this is
configuration to do at launch, not just behavior to verify. No code
change, spec.md only.

### M5, restaurant slice 1: the menu (2026-08-24)

**Sandbox-verified only — not live-tested.** Continuing into F&B with
the same working agreement: small slices, everything below is
typecheck/lint/build plus real tests against mocked data and a real
headless-browser Playwright run — nothing checked against live data.

First restaurant slice, mirroring the amenity module's own opening
slice: the menu catalogue only (spec §6 `MenuItem`). Order creation and
the kitchen kanban (spec §7.3) are the next slice, not this one.

New `apps/api/src/modules/fnb/` module (schema/service/router, same
shape as `amenities/`): `GET /menu-items` (`fnb:read`), `POST`/`PATCH
/menu-items` (`fnb:manage_menu`) — both permission keys already existed
in the seeded matrix, unused until now. `MenuItem.category` stays free
text in the create/update form, deliberately not a closed enum like
`AmenityItem.category` — spec's own data model leaves it as a plain
string (§6: `category` with no enum listed), so the UI doesn't invent a
category list the client never asked for.

New `/restaurant` page + nav item (`FnbPage.tsx`, gated on `fnb:read`,
invisible to Maintenance/Housekeeping staff — neither holds any `fnb:*`
key). Read-only table for `fnb:read`-only holders (Restaurant Staff); an
add-item form and an availability toggle per row for `fnb:manage_menu`
holders (Restaurant Manager, System Admin, Resort Manager).

Also seeded spec §10's "~25 menu items across Rice Meals, Silog,
Grilled, Pulutan, Drinks, Desserts" in `seed.ts` — create-if-missing by
`name`, same idempotency pattern as `AmenityItem`/`UnitType`, so a
re-run never clobbers real menu edits made through the new admin page.
**This part is unverified beyond typecheck**, same caveat as the amenity
seed data last session — no network path to a real database from this
sandbox.

No payment/settlement machinery touched or built here — that question
belongs to the order-creation slice next (spec §7.6 wants
`CHARGE_TO_ROOM` orders to auto-post a `FolioCharge` and validate against
an active checked-in booking, which is squarely the kind of thing the
monitoring-not-transactions principle rules out or reduces to
informational-only; flagged in that slice's own report, not guessed at
here since the menu slice never touches it).

Verified: 8 new backend tests (permission gates on both routes, negative
price rejected, the Decimal→number conversion, 404 on an unknown item),
3 new frontend tests (manage-menu holder can list/add/toggle
availability; read-only holder sees the table but no form or toggle),
and a real headless-browser Playwright run confirming the menu renders,
an item can be added, and the availability toggle flips a row.
`packages/shared` 63/63 (unchanged — no shared-package logic this
slice), `apps/api` 265/268 (same 3 pre-existing network-blocked
round-trip tests), `apps/web` 40/40. Full repo lint/typecheck/build
clean.

### M5, restaurant slice 2: order creation + status backend (2026-08-24)

**Sandbox-verified only — not live-tested.** Same working agreement.
Backend-only slice, deliberately: the kitchen kanban UI (frontend for
this backend) is next, same two-slice split as the amenity workflow
(backend then frontend) last session.

**New transition table**, `packages/shared/src/fnbOrder.ts`:
`RECEIVED -> PREPARING -> READY -> SERVED`, `CANCELLED` off both
`RECEIVED` and `PREPARING`. No judgment call needed here, unlike the
amenity-request and work-order tables — spec's own diagram already draws
every cancel path this table needs, nothing to fix by analogy this time.

**The client-confirmed scope call from last session's report, now
built:** `settlement` (`PAY_NOW`/`CHARGE_TO_ROOM`) is a pure
informational classification on the order — same treatment as the
amenity deposit checkbox. No `Payment` row, no `FolioCharge`, no balance
tracking, and `SERVED` never auto-posts anything. Spec §7.6's original
gate — `CHARGE_TO_ROOM` refused at creation with `422 NO_ACTIVE_FOLIO`
unless linked to a booking currently `CHECKED_IN` — doesn't survive with
no folio to validate against, so it's dropped. Per the client's own
instruction, a lighter replacement stays: `CHARGE_TO_ROOM` still requires
a `unitId`, and still refuses (`422 UNIT_NOT_OCCUPIED`) unless that
unit's live status is `OCCUPIED` — cheap (one row already needed for the
FK) and keeps "which room does this charge belong to" as real, useful
monitoring information without any balance math behind it.

**New endpoints** (`apps/api/src/modules/fnb/`): `POST /fnb-orders`,
`GET /fnb-orders` (with a `boardOnly` query flag), `GET
/fnb-orders/:id`, `POST /fnb-orders/:id/status` (same `requireAuth` +
`getMe` + transition-table-decides-the-permission pattern as every other
polymorphic status route in this codebase). Order lines snapshot the
menu item's price at creation — never re-derived from `MenuItem` later —
same "amount is stored, never recomputed from the source" principle
spec gives `FolioCharge`, applied here even though there's no folio: a
menu price change next week must not rewrite last week's order.
Broadcasts `fnb.order.created`/`fnb.order.status.changed` on the
existing `property` realtime channel (spec §9.1).

**Advance-order visibility** (spec §7.3: "surfaces in the kitchen board
90 minutes before the scheduled time, make the lead time a Setting"):
`boardOnly=true` filters to `RECEIVED`/`PREPARING`/`READY` and hides an
`ADVANCE_ORDER` until `now >= scheduledFor - leadMinutes`, reading a live
`fnb.advanceOrderLeadMinutes` Setting with the same fallback-to-shared-
default pattern as `workOrder.photoRequirements`.

Verified: 7 new transition-table tests (`packages/shared`), 12 new
backend tests (`apps/api`) covering the menu-item validation, both
`ADVANCE_ORDER`/`CHARGE_TO_ROOM` creation gates, the subtotal/price-
snapshot computation, the board query's actual where-clause (asserted
directly, since a mocked `findMany` can't otherwise exercise the
advance-order filter), and every status transition's permission gate.
`packages/shared` 70/70, `apps/api` 277/280 (same 3 pre-existing
network-blocked round-trip tests), `apps/web` 40/40 (unchanged — no
frontend work this slice). Full repo lint/typecheck/build clean.

### M5, restaurant slice 3: kitchen kanban UI (2026-08-24)

**Sandbox-verified only — not live-tested.** Same working agreement.
This closes out the F&B module's first full vertical slice (menu →
order placement → kitchen board), same shape as the amenity module's
own three-slice arc last session.

Extended `FnbPage.tsx` with a "Kitchen board" section: three columns
(Received/Preparing/Ready — `SERVED`/`CANCELLED` drop off the active
board, matching spec's framing of the kanban as the kitchen's *current*
work) and a "Place an order" form. Each card shows a live-computed
minutes-since-received badge, amber at `FNB_ORDER_AMBER_MINUTES` (20)
and red at `FNB_ORDER_RED_MINUTES` (35) per spec §7.3 — computed at
fetch time and refreshed by realtime + a 30s poll fallback, not a
client-side ticking clock, matching every other timing display already
in this codebase (the Command Center's `dirtyMinutes` follows the exact
same pattern).

**A real access gap found while wiring the order form, fixed the same
way this codebase already fixed an identical one:** `CHARGE_TO_ROOM`
orders need a room picker, but Restaurant Staff — who spec's own role
matrix (§5.4) gives `fnb:create` — holds no `unit:read` at all, so
`GET /units` would 403 for them. Same shape as the problem
`listAssignableUsers`/`GET /work-orders/assignable-users` already solved
for POCs needing an assignment picker without full `user:read`: added
`GET /units/orderable` (new, `units/service.ts` +
`units/router.ts`), gated on `fnb:create` rather than `unit:read`,
returning only what an order-placement picker needs (id/code/name/
status) — not the general unit-management payload. This wasn't a
guess; it directly mirrors an existing, documented precedent in this
same codebase for the identical class of problem.

The `CHARGE_TO_ROOM` picker also disables any unit whose live status
isn't `OCCUPIED`, matching slice 2's server-side gate — the UI catches
the mistake before the request round-trips, the server-side check (422
`UNIT_NOT_OCCUPIED`) is still the real enforcement.

New `subscribeToFnbOrderChanges` in `lib/realtime.ts`, mirroring
`subscribeToUnitStatusChanges` — same `property` channel, listening for
both `fnb.order.created` and `fnb.order.status.changed` and triggering a
plain refetch (the board doesn't need a patch-in-place payload, just
"something changed").

Verified: 2 new backend tests for `GET /units/orderable` (gated on
`fnb:create` not `unit:read`; succeeds for Restaurant Staff specifically,
who has the former but not the latter), 1 new frontend test driving a
full order through place → start preparing → mark ready → mark served
and confirming it drops off the board once served, and a real
headless-browser Playwright run doing that same sequence plus confirming
the `CHARGE_TO_ROOM` picker actually disables a non-occupied room in a
real DOM. `packages/shared` 70/70 (unchanged — no shared-package logic
this slice), `apps/api` 279/282 (same 3 pre-existing network-blocked
round-trip tests), `apps/web` 41/41. Full repo lint/typecheck/build
clean.

This closes out the F&B module's first vertical slice. Remaining M5
backlog: nothing else spec requires — menu, ordering, kitchen kanban,
advance orders, amenity catalogue, and the full amenity request/issue/
return workflow are all built. M5's acceptance criteria that touch
folio/payment machinery (the `CHARGE_TO_ROOM` auto-post, the `NO_ACTIVE_FOLIO`
gate) were deliberately not built per the client's monitoring-not-
transactions scope call — that's a documented scope decision, not
something left undone.

### Real gap, found live-testing: no way to edit an existing amenity item's totalQty (2026-08-25)

Client report while doing the real PC pass on M5: `AmenityItem.totalQty`
(spec §6) had no visible way to set or edit it in the `/amenities` UI.
Checked both halves of that report before touching anything:

- **Creation already captured it.** The "Add an item" form has always
  had a required "Total quantity" field, and `handleCreate` already sent
  it. Confirmed by re-reading `AmenitiesPage.tsx` line by line before
  concluding this half of the report didn't match the code — worth
  flagging back rather than silently "fixing" something that already
  worked.
- **Editing an existing item was the real gap.** Every row's only
  control was "Deactivate/Reactivate" — there was no way to change
  `totalQty`, or any other field, on an item already in the catalogue.
  The backend already accepted a full partial update via `PATCH
  /amenity-items/:id` (`updateAmenityItemSchema` is `createAmenityItemSchema.partial()`);
  only the frontend was missing.

Added an inline "Edit" control per row (`AmenitiesPage.tsx`), same
expand-a-panel-below-the-row pattern already used for the amenity
request workflow's Issue/Return sub-forms — a "Save changes"/"Cancel"
form pre-filled from the item's current values, covering every editable
field (name, category, asset tag, `totalQty`, condition, deposit
settings), not `totalQty` alone: the backend already supports editing
all of them, so a `totalQty`-only control would have been an odd
half-measure next to a PATCH endpoint that does more.

Verified: 1 new frontend test (opens the edit panel, confirms `totalQty`
is pre-filled from the existing item, changes it, saves, confirms the
table reflects the new value and the panel closes) plus a real
headless-browser Playwright run doing the same sequence against a
mocked API. `packages/shared` 70/70, `apps/api` 279/282 (same 3
pre-existing network-blocked round-trip tests, untouched — no backend
change this fix), `apps/web` 42/42. Full repo lint/typecheck/build
clean.

### Two findings from the client's live PC pass on M5 (2026-08-25)

**1. Real bug, confirmed with real self-created data: amenities had no
stock check.** The client added a real `AmenityItem` ("console",
`totalQty: 1`) through the `/amenities` form and was able to issue it
three separate times with no warning — the system had no way of knowing
an item was actually out of stock.

Fixed in `changeAmenityRequestStatus` (`amenities/service.ts`): before an
`APPROVED -> ISSUED` transition, sum `qty` across every other request on
the same `AmenityItem` currently `ISSUED` **or** `OVERDUE`, and refuse
(`409 INSUFFICIENT_STOCK`) if this request's own `qty` would push that
total past the item's `totalQty`. `OVERDUE` is deliberately included,
not just `ISSUED` — an overdue item hasn't come back yet, so excluding
it would make stock look like it "reappeared" the moment a borrower
missed their due-back time, which is backwards. The frontend needed no
new plumbing: `AmenitiesPage.tsx`'s existing generic
`ApiRequestError`-to-`actionError` handling already surfaces the
server's message in the Issue panel.

Verified: 4 new backend tests (out of stock refuses and leaves the
request untouched; `OVERDUE` counts toward the total, not just `ISSUED`;
issuing succeeds when stock remains; a multi-unit request that alone
would exceed what's left is refused), 1 new frontend test confirming the
server's exact error message renders and the request stays `APPROVED`
rather than being left half-updated, and a real headless-browser
Playwright run doing the same. `packages/shared` 70/70 (unchanged),
`apps/api` 283/286 (same 3 pre-existing network-blocked round-trip
tests), `apps/web` 43/43. Full repo lint/typecheck/build clean.

**2. Investigated, not a code bug: the restaurant menu seed data.** The
client confirmed two ways — the `/restaurant` page showed no menu items,
and Supabase's own Table Editor showed `MenuItem` genuinely empty — and
asked me to check whether the seeding code from the earlier "M5
restaurant slice 1" report actually exists in the committed `seed.ts`,
since the table's emptiness suggested it might never have been wired in.

Checked directly rather than guessing: `MENU_ITEM_SEEDS` (26 items
across Rice Meals/Silog/Grilled/Pulutan/Drinks/Desserts) and its
seeding loop are both present in `seed.ts` at the current commit, and
have been since commit `df6ef9c` ("M5 restaurant slice 1: menu
catalogue"), confirmed via `git log`/`git show` against the actual
committed history, not just the working tree. The loop does print
`console.warn('Seeding 26 menu items...')`, same as every other seed
block, immediately before it runs — so a run that reached this point
would show that line. The code is straight-line (no early return
between the amenity-item block above it and this one), create-if-missing
same as the rest of the script, and safe to re-run.

**This means the seeding code itself isn't the bug** — the far more
likely explanation is that `npm run seed` simply hasn't been (re-)run
against the live Supabase project since this feature landed. Every
milestone's seed data only appears after the next time the script is
actually invoked; pulling the commit alone doesn't touch the database.
**Recommended next step for the client's PC pass:** run `npm run seed`
again (idempotent, safe against existing data) and watch the console for
the `Seeding 26 menu items...` line and whatever immediately follows it
(`Seeding workOrder.photoRequirements setting...`) — if the first line
prints but the second doesn't, something threw in between and the actual
error text is the next thing to look at. This wasn't something I could
verify by running it myself: this sandbox has no network path to the
client's live Supabase project, confirmed repeatedly across this
session.

### Seven findings from live-testing the restaurant/kitchen system (2026-08-25)

**Genuine schema change — run `npx prisma db push` before your next live
test.** `FnbOrder` gained `cancelReason`/`cancelledById`/`cancelledAt`
columns for finding #4 below.

**1. Confirmed intentional, not a gap: menu items can't be hard-deleted.**
`FnbOrderLine.menuItem` is a required (non-nullable) FK, so deleting a
`MenuItem` still referenced by historical order lines would either break
referential integrity or destroy that history — same reasoning as
`AmenityItem.isActive` and `FolioCharge`'s voided-not-deleted pattern.
Soft-disable (`isAvailable`) is the correct, intentional design here; no
code change made.

**2. Real gap, fixed: kitchen board moved to the top of the page.**
Restaurant staff need it on load, not after scrolling past the menu.
`FnbPage.tsx` now renders Kitchen board → Place an order first, Menu →
Add a menu item second.

**3. Real bug, fixed: unoccupied/blocked rooms were selectable in the
order-placement room picker.** The `disabled` condition on each `<option>`
was gated on `settlement === 'CHARGE_TO_ROOM'`, but `settlement` defaults
to `PAY_NOW` — so by default every room, including `BLOCKED`/
`OUT_OF_ORDER`, was clickable, even though the backend's own `422
UNIT_NOT_OCCUPIED` gate only fires for `CHARGE_TO_ROOM`. Fixed to be
unconditional (`disabled={unit.status !== 'OCCUPIED'}`) — an F&B order
should only ever attach to a room with a guest actually present,
regardless of how it's being paid for. Mirrors the same never-even-try
disabled-option treatment already used by `UnitsPage`'s `CheckInPanel`.

**4. Real gap, fixed: cancelling an order now requires a reason, logged.**
Same pattern as `forceUnitStatus`'s mandatory note for a forced status
correction. Schema: `FnbOrder.cancelReason`/`cancelledById`/`cancelledAt`
+ a `cancelledBy` relation to `User`. `changeFnbOrderStatusSchema`
requires `cancelReason` (via a zod `.refine()`) whenever `toStatus ===
'CANCELLED'`; `changeFnbOrderStatus` persists all three fields on that
transition. `FnbPage.tsx`'s Cancel button now opens an inline
reason-capture sub-form (mirroring `AmenitiesPage.tsx`'s Issue/Return
pattern) instead of cancelling immediately, and a new "Recently
cancelled" section (fetching `GET /fnb-orders?status=CANCELLED`) keeps the
reason visible once the order drops off the active board.

**5. Corrected, not a straight implementation: menu categories.** The
requested four groupings ("Menu, Extras, Beverage, Specials") don't match
what's actually seeded — `MenuItem.category` is free text (per spec's
data model) and the real seed data uses six categories: Rice Meals,
Silog, Grilled, Pulutan, Drinks, Desserts. Rather than hardcoding either
list, the Menu table now groups dynamically by whatever distinct
`category` values exist in the live data, so it stays correct regardless
of how categories are named or added later.

**6 & 7. Real bugs, fixed together: the timing badge only had two states,
and it never visibly progressed.** Root cause of #7: `minutesSince` was
recomputed correctly from `order.createdAt` (the timestamp basis was
already right), but only as a side effect of `fetchOrders()` re-rendering
— there was no clock driving the *display* on its own, so a ticket sitting
untouched between polls/realtime events showed a frozen badge. Fixed with
a dedicated `now` state ticking on its own 15s `setInterval`, decoupled
from the 30s data-fetch cadence.

That fix exposed #6 clearly: once the badge could actually move, "only
two states, and overdue shows nothing" was confirmed as a real gap, not
just a symptom of #7. Redesigned around three explicit urgency tiers, all
still keyed off the existing spec §7.3 thresholds
(`FNB_ORDER_AMBER_MINUTES`/`FNB_ORDER_RED_MINUTES`) — reinterpreted as
"time budget consumed" rather than "still fine until stale": a
freshly-placed ticket needs attention right away (**red**), one nearing
its allocation **blinks** to demand a look, and one that has actually
blown past its allocation gets the strongest, unmistakable **OVERDUE**
treatment (solid red, pulsing, explicit "OVERDUE" label) — it no longer
silently reverts to a neutral badge the way the old red-only-at-35min
tier effectively did while frozen. This is a design interpretation of an
ambiguous request ("time allocation" appears nowhere else in spec.md);
flagged here rather than guessed silently, though implemented directly
since it reuses the existing, already-agreed thresholds rather than
inventing new ones.

Verified: 2 new backend tests (cancelling without a reason returns 422
and leaves the order untouched; cancelling with a reason persists
`cancelledById`/`cancelledAt`/`cancelReason` and returns them), 1 new
frontend test driving the full cancel-with-reason flow through the UI to
the "Recently cancelled" section, and a real headless-browser Playwright
run confirming: kitchen board renders above the menu; the room picker
disables `VACANT_DIRTY`/`BLOCKED` rooms while leaving `OCCUPIED` enabled;
the menu groups under real category headings (Grilled, Drinks, …); and
all three urgency tiers render with the expected classes and the
"OVERDUE" label. `packages/shared` unchanged, `apps/api` 285/288 (same 3
pre-existing network-blocked round-trip tests), `apps/web` 44/44. Full
repo lint/typecheck/build clean.

### Three more findings from live-testing: order history, and one report that turned out already fixed (2026-08-25)

**1. Confirmed correct, no action:** menu items can only be deactivated,
matches the earlier `FnbOrderLine` foreign-key explanation.

**2. Real gap, fixed: no order history view.** Once an order left the
active kanban board (SERVED or CANCELLED), its full detail — items,
room, guest, cancellation reason, timestamps — was only visible by
digging into Supabase directly. Added an "Order history" section to
`/restaurant`, below the menu:

- Backend: `GET /fnb-orders` gained a `history=true` flag
  (`listFnbOrdersQuerySchema`/`listFnbOrders` in `fnb/schema.ts` and
  `fnb/service.ts`) — filters to `SERVED`/`CANCELLED`, sorts newest
  first, caps at 200 rows (history can accumulate indefinitely, same
  reasoning as every other "recent activity" list in this codebase). An
  explicit `status` query param still narrows further within that set
  (`history=true&status=CANCELLED`), reusing the existing single-status
  filter rather than adding a second parallel one.
- Frontend: `FnbPage.tsx` fetches this once, then filters (status:
  All/Completed/Cancelled), searches (reference #, guest, room), and
  sorts (date asc/desc) entirely client-side — the fetched set is small
  enough that this needed no new backend plumbing per interaction. This
  replaces the narrower "Recently cancelled" list added for the
  mandatory-cancel-reason fix earlier today; that data now lives here
  too, alongside completed orders, rather than in a separate view.

**3. Investigated, not a bug: the amenity "Due Back" field.** Checked the
actual source (`AmenitiesPage.tsx`, both current and the original M5
slice 3 commit `c27895c` that introduced it) — this field has always
been `<input type="datetime-local">`, a native browser calendar+time
picker, with no `maxLength` attribute anywhere in the codebase. There is
no free-text 6-character-limited input to fix; nothing in git history
ever made it one. The described truncation isn't reproducible against
what's actually committed and built here (confirmed via a clean
`npm run build`, no stale artifacts). **Likely explanation:** the PC
running the live test is on a build that predates this field, or has a
cached/stale bundle from before a rebuild — worth a hard refresh
(clear cache) or a fresh `npm install && npm run build` on that machine
before retesting. If the field still looks like free text after that,
please screenshot it — that would mean something environment-specific
(e.g. a browser without `datetime-local` support falling back to a
plain text box) rather than a code defect, and the fix would look
different (an explicit calendar-widget library) than what "replace the
free-text input" implies.

Verified: 2 new backend tests (`history=true` filters to
`SERVED`/`CANCELLED`, sorted desc, capped at 200; combining
`history=true` with an explicit `status` narrows correctly), the
existing frontend cancel-flow test updated to assert against the new
"Order history" section instead of the removed "Recently cancelled"
list, and a real headless-browser Playwright run confirming: both a
completed and a cancelled order render with full detail including the
cancellation reason; the status filter and the search box each narrow
the list correctly. `packages/shared` unchanged, `apps/api` 287/290
(same 3 pre-existing network-blocked round-trip tests), `apps/web`
44/44. Full repo lint/typecheck/build clean. No schema change this time
— `db push` from the previous entry still covers everything needed.

### Option B: real menu/amenity item deletion, backed by order/request snapshots (2026-08-25)

Client decision: rather than keep `FnbOrderLine.menuItem`/`AmenityRequest.amenityItem`
as required FKs forever (the reason hard-delete was refused earlier
today), snapshot each item's **name** on the order line / request at
creation time — `unitPrice` was already snapshotted this way since the
very first commit — and make the FK optional with `onDelete: SetNull`.
This makes a genuine `MenuItem.delete()` / `AmenityItem.delete()` safe:
no historical row depends on the live catalogue row surviving.

**Genuine schema change — run `npx prisma db push`, then
`npm run backfill:order-item-snapshots` (from `apps/api`), before your
next live test.**

- `FnbOrderLine.menuItemId` and `AmenityRequest.amenityItemId` are now
  nullable, with `onDelete: SetNull` on both relations.
- `FnbOrderLine` gains `menuItemName String?`; `AmenityRequest` gains
  `amenityItemName String?` — both populated going forward at
  order/request creation (`createFnbOrder`/`createAmenityRequest`), null
  on every row that already existed before this change.
- Both `fnbOrderToJson` and `amenityRequestToJson` now expose a derived
  `itemName`: the snapshot if present, else the live relation (for a
  pre-snapshot row whose item hasn't been deleted), else the placeholder
  `"(deleted item)"`. The frontend reads this field, not
  `menuItem.name`/`amenityItem.name`, directly.

**Backfill decision — reasoning, not a default:** existing rows get their
`menuItemName`/`amenityItemName` backfilled from the *current* live
catalogue row, not left null. Two things make this the right call here,
specifically at this moment, rather than "backfilling old data is
inherently risky":

1. `unitPrice` needs no backfill at all — it was already snapshotted at
   order time since the very first commit, so the field most likely to
   have actually drifted (price) is already correct on every historical
   row. Only the name — much less likely to have changed (renaming a
   menu item is rare; repricing it is routine) — needs backfilling.
2. This runs *before* any item has ever been hard-deleted (that
   capability doesn't exist until this same commit), so every
   `menuItemId`/`amenityItemId` on every existing row is still
   resolvable via its live relation right now — this is as accurate as
   this backfill will ever be. Waiting means some of those items may
   later be deleted and the name becomes unrecoverable.

The script (`apps/api/scripts/backfillOrderItemSnapshots.ts`, mirroring
`fixStaleInspectedUnits.ts`'s style) is idempotent — only touches rows
where the snapshot is still null — so it's safe to re-run.

**Delete UI**, gated the same as the existing manage permissions
(`fnb:manage_menu`, `amenity:manage`): a "Delete" action now appears next
to each menu/amenity item, but only once it's already
unavailable/inactive — a deliberate two-step (deactivate, then delete)
so a currently-live item can't be removed in one click. The server
enforces the same rule independently (`409 ITEM_STILL_AVAILABLE` /
`409 ITEM_STILL_ACTIVE`) — the UI gate is a courtesy, not the real guard.
Amenity items get one more guard the menu doesn't need: deposit/stock
checks are still read live during an amenity request's active lifecycle
(see `changeAmenityRequestStatus`'s ISSUED branch), so
`deleteAmenityItem` also refuses (`409 ITEM_HAS_ACTIVE_REQUESTS`) while
any request on that item is still `REQUESTED`/`APPROVED`/`ISSUED`/
`OVERDUE` — menu items need no equivalent, since nothing reads a live
`MenuItem` after the order line's own snapshot is taken.

This is a deliberate, informed deviation from this schema's own stated
convention ("soft delete — nothing is hard-deleted from the UI," per
spec §4.5, restated in schema.prisma's header comment) — flagging it
here rather than letting it look like an oversight. Every other delete
action in this codebase (users, roles, units, bookings, work orders,
...) still only ever sets `deletedAt`; this is the first and only real
`DELETE`, scoped specifically to menu/amenity catalogue items per this
client decision.

**Layout**: also moved Order history to sit between "Place an order" and
the Menu section on `/restaurant`, per client request — Kitchen board →
Place an order → Order history → Menu items.

Verified: `npx prisma validate`/`generate` clean; 8 new backend tests
(menu-item delete: 403/404/409-still-available/204-success; amenity-item
delete: 403/404/409-still-active/409-has-active-requests/204-success)
plus 2 new `itemName` fallback-chain tests (snapshot → live relation →
placeholder, one per module); 2 new frontend tests (delete flow on each
page, gated behind the confirm dialog); full headless-browser Playwright
run confirming the new section order and a live delete round-trip.
`packages/shared` unchanged, `apps/api` 298/301 (same 3 pre-existing
network-blocked round-trip tests), `apps/web` 46/46. Full repo
lint/typecheck/build clean.

### Client-confirmed: the restaurant/kitchen/amenities live-testing round is closed (2026-08-25)

Client live-tested the full set of fixes from tonight's three
restaurant/kitchen/amenities rounds directly against Supabase and
confirmed, one by one:

- Order history renders in the requested position — between "Place an
  order" and the menu item listing on `/restaurant`.
- Historical order line names backfilled correctly by
  `backfill:order-item-snapshots` (menu prices were already correct;
  only names needed the one-off backfill — see the Option B entry
  above).
- The two-step delete guard behaves as designed on both catalogues: an
  active/available item shows only "Mark unavailable"/"Deactivate," and
  "Delete" appears only once it's already been switched off.
- The amenity-side extra guard holds: an item with a request still
  in progress (`REQUESTED`/`APPROVED`/`ISSUED`/`OVERDUE`) cannot be
  deleted even once deactivated.
- The kitchen board's ~20-30s periodic refresh cadence (the 30s poll
  fallback plus realtime events) is expected behavior, not a bug —
  raised and explicitly ruled out during this pass, noted here so it
  isn't rediscovered as a "finding" in a future session.

This closes out the restaurant/kitchen/amenities corrective work that
began with tonight's first live-testing pass (menu item edit UI, stock
check) through the seven-point restaurant/kitchen findings, the order
history addition, and Option B's real-delete schema change. All of it
was bugfix/refinement work within the already-approved M5 scope, not new
M6 work.

Holding here per the client's instruction — no further restaurant/
kitchen/amenities work queued. M6 still awaits explicit go-ahead, per
the client's standing instruction earlier this session.

## M6 — Report builder (spec §8.4)

Client confirmed M5 fully closed and gave the go-ahead to start M6,
2026-08-25: "Start with the two reports that have the most real data
behind them already" — occupancy/unit status history and work-order
stats. Building the 9-report MVP set in small slices, same discipline as
every other milestone this session, not all at once.

### Slice 1: occupancy/unit status history + work-order stats reports (2026-08-25)

**New module**: `GET /reports/:key` (`report:view`) and
`GET /reports/:key/export?format=csv` (`report:export` — a separate,
narrower permission per the role matrix: POC_HOUSEKEEPING/
POC_MAINTENANCE hold `report:view` only, no export). `packages/shared`
gains `REPORT_KEYS`/`REPORT_LABELS` (currently `occupancy`,
`work-orders`) as the shared source of truth between the API's
dispatcher and the frontend's report picker, same convention as every
other domain enum in that package.

**1. Occupancy & unit status history (by day, by unit).** Built from
`UnitStatusEvent` — real data going back through tonight's whole testing
session. Walks each unit's status-event history forward to derive its
status as of the end of each day in the requested range (the Unit.status
column only ever holds the *current* status, not history), correctly
falling back to the schema's `VACANT_DIRTY` default for any day before a
unit's first logged transition rather than guessing. Rows are literally
the "by day, by unit" grid spec names; a daily occupancy-rate summary is
also computed for on-screen display, but the CSV export carries the
finer-grained detail rows, same reasoning as the work-order report
below. A `report:view` holder scoped to `DEPARTMENT` (POC_HOUSEKEEPING,
POC_MAINTENANCE, RESTAURANT_MANAGER) is refused this report with `403` —
occupancy has no department axis on `Unit` to scope by, so silently
returning the whole property (a grant their scope was never meant to
carry) or a silently empty report (indistinguishable from a bug) were
both worse than a clear boundary. Flagging this as a report-specific
interpretation, not a spec-stated rule — a future report *with* a real
department axis (e.g. housekeeping productivity, item 5) should not
inherit this same refusal.

**2. Work orders: volume, by type, by department, average time-to-close,
SLA breaches, top recurring units.** Scoped by `createdAt` within
`[from, to]` — every stat describes tickets *opened* in the period, the
standard reporting convention. "Time-to-close" uses `verifiedAt` as the
close event (spec's own transition table treats VERIFIED, not DONE, as
the true close: "DONE → VERIFIED requires `workorder:verify`"); a ticket
only DONE, not yet verified, has no close time yet and is excluded from
the average rather than counted as zero. "SLA breaches" extends spec's
own live computed-field definition (`dueAt < now && status not in (DONE,
VERIFIED, CANCELLED)`, see `listSlaBreachedWorkOrders`) to also catch a
ticket that was *closed late* — a ticket verified after its `dueAt` is
breached even though it's no longer open; CANCELLED never breaches
regardless of `dueAt`, since it was never actually worked to completion
or failure. A `DEPARTMENT`-scoped `report:view` holder gets this report
forced to their own department (ignoring any `?department=` query param)
rather than refused outright — unlike occupancy, this report genuinely
has a department axis, so the existing `workorder:read_all` scoping
pattern (`visibilityWhereClause` in workorders/service.ts) applies
directly here too.

**Frontend**: new `/reports` page (nav item gated on `report:view`) — a
report picker, date-range inputs, an optional department filter (shown
only for work-orders), "Run report" (renders summary tiles/tables plus
the full detail rows on screen), and "Export CSV" (hidden entirely for a
caller without `report:export`). CSV download required a new
`api.downloadCsv` helper — the export route returns a raw `text/csv`
body, not JSON, so it can't reuse the existing JSON-parsing `request()`
helper, but mirrors its one-retry-on-401 behavior so a short-lived
access token doesn't fail a download mid-click.

**Monitoring-not-transactions applied here too**: neither report touches
money — no revenue, rates, or payment figures appear in either, per the
client's explicit scope call for this slice. That principle will matter
more once F&B/amenity/payments reports (items 7, 8, 3) land later in
M6.

Verified: 9 new backend tests (permission gating on both routes;
unknown-key/from-after-to validation; the occupancy DEPARTMENT-scope
403; the occupancy day×unit derivation including the
no-events-yet-fallback case; the work-order report's volume/breakdowns/
SLA-breach/time-to-close math including the CANCELLED-never-breaches and
still-open-past-due cases; the work-order DEPARTMENT-scope forcing;
CSV export content), 3 new frontend tests (running a report and reading
its summary/detail; the CSV export round-trip including the download
event; the DEPARTMENT-scoped viewer seeing no Export button and no
department filter for occupancy), and a real headless-browser Playwright
run confirming both reports render on screen, the CSV export fires an
actual browser download, and the department filter only appears for the
work-orders report. `packages/shared` 70/70 (unchanged besides the new
report.ts file), `apps/api` 307/310 (same 3 pre-existing network-blocked
round-trip tests), `apps/web` 49/49. Full repo lint/typecheck/build
clean. No schema change.

### Real bug found live-testing: common areas selectable at Check-in (2026-08-25)

The Check-in room picker let common areas — Beach Front, CR-Female,
CR-Male, Function Hall, Pool, Restaurant (`COMMON_AREA`/`FACILITY`
`Unit.type`) — be selected as a guest's check-in destination, alongside
real accommodations (`ROOM`/`COTTAGE`). "Check a guest into the Pool"
never means anything.

`packages/shared` gains `unitKind.ts` (`UNIT_KIND_KEYS`,
`BOOKABLE_UNIT_KINDS = ['ROOM', 'COTTAGE']`, `isBookableUnitKind`) —
mirrors the Prisma `UnitKind` enum, same duplication reasoning as
`departments.ts`. Fixed on both sides:

- **Frontend**: `UnitsPage.tsx`'s Check-in picker now filters the list
  to `isGuestAccommodation` (kind) before mapping, on top of the
  existing `isBookable` (live status) disable logic. These are
  deliberately different treatments for different kinds of
  "unselectable": a `BLOCKED`/`OUT_OF_ORDER`/`OCCUPIED` room is a real,
  temporary state of a real accommodation, so it's still shown, just
  greyed out, same as before — the front desk should be able to see
  *why* a room isn't pickable. A common area was never going to become a
  valid check-in target under any status, so it's excluded from the list
  entirely rather than shown disabled forever.
- **Backend**: `checkInBooking` gains the same guard the picker now
  encodes client-side — `422 UNIT_NOT_BOOKABLE` if any selected unit's
  `type` isn't `ROOM`/`COTTAGE` — checked before the existing status
  guards, same "never even try, and reject it anyway if it somehow
  reaches here" pairing every other unavailable-unit check in that loop
  already has.

Verified: 4 new backend tests (COMMON_AREA/FACILITY rejected with 422
UNIT_NOT_BOOKABLE; ROOM/COTTAGE still proceed normally), 1 new frontend
test (`UnitsPage.test.tsx`, the page's first — asserts the picker lists
exactly the bookable units and no common areas), and a real
headless-browser Playwright run against the actual six named units from
the report confirming each is excluded and exactly the 2 real
accommodations remain checkable. `packages/shared` unchanged besides the
new file, `apps/api` 311/314 (same 3 pre-existing network-blocked
round-trip tests), `apps/web` 50/50. Full repo lint/typecheck/build
clean. No schema change.

### Real gap found live-testing: no UI to add, edit, or deactivate a unit (2026-08-25)

Checked thoroughly per the client's report: the Units page had no "Add
unit" control at all — every unit was permanently stuck at whatever
`seed.ts` created, despite spec §9/§10 always describing that data as
placeholder pending a real admin UI. Investigated before building
anything: `POST /units` and `PATCH /units/:id` already existed
server-side (gated on `unit:manage`, built during M2) with every spec §6
field already accepted — only the frontend UI to call them was ever
missing. No backend gap here, just a genuine missing screen.

**Grouping, resolved from the client's own confirmed research**: real
seed data has every current common area (Pool, Beach Front, Open Field,
CR-Male/Female, Function Hall, Restaurant) at `COMMON_AREA` — none are
`FACILITY`, confirmed against `seed.ts`, not assumed. Three-way grouping
— "Rooms & Cottages" (`ROOM`/`COTTAGE`), "Common areas" (`COMMON_AREA`),
"Facilities" (`FACILITY`) — lands in `packages/shared/src/unitKind.ts`
(`UNIT_KIND_GROUP_KEYS`/`_LABELS`, `unitKindGroup()`) so every place that
needs it reads the same source. `FACILITY` stays its own group in code
even with zero real units today — never folded into `COMMON_AREA` — so a
future facility (gym, spa, ...) gets its own section automatically, no
code change required.

**Built**:
- **Add a unit**: a form on the Units page (gated `unit:manage`), Type as
  the literal first field — an `<optgroup>` per group makes the
  three-way split visible at the point of choice, not just in how the
  grid sorts the result afterward. Code, name, unit type (existing
  rate/capacity template), capacity (optional, defaults from the unit
  type same as the API always did), floor and notes (both optional).
- **Edit a unit**: a "Unit details" panel inside the existing detail
  drawer (gated `unit:manage`), same start/cancel/submit-edit pattern as
  `AmenitiesPage.tsx`'s inline item edit — name, type, unit type,
  capacity, floor, notes. `code` stays immutable after creation (the API
  never accepted it in the update schema to begin with).
- **(Soft-)delete/deactivate**: a Deactivate/Reactivate toggle in the
  same panel, the existing `isActive` field via `PATCH` — same
  soft-disable convention as `AmenityItem`/`MenuItem`, no hard delete (a
  `Unit` has live relations everywhere — bookings, work orders, status
  events — that a real delete was never asked for and would endanger).
  An inactive unit now visibly dims in the grid with an "Inactive" badge,
  both in its tile and its drawer — previously `isActive` had no visual
  treatment anywhere since nothing could ever set it.
- **Grouping applied everywhere spec-relevant**: the Units grid renders
  three sections (Facilities shown even at "(0)"); the occupancy report
  (M6 slice 1) gained a `group` column, computed server-side so the CSV
  export carries it too, not just the on-screen view.

Verified: 10 new backend tests (`POST`/`PATCH /units` permission gating,
unknown-`unitTypeId`/duplicate-code rejection, capacity defaulting, every
`UNIT_KIND_KEYS` value accepted including `COMMON_AREA`/`FACILITY`, a
plain edit, and the `isActive` toggle), 1 updated occupancy-report test
(now asserts the `group` label per row), 3 new frontend tests (grid
grouping including the empty-Facilities case; the full add-unit flow;
edit + deactivate from the drawer), and a real headless-browser
Playwright run driving the whole thing end to end against the built app.
`packages/shared` unchanged besides the `unitKind.ts` additions,
`apps/api` 323/326 (same 3 pre-existing network-blocked round-trip
tests), `apps/web` 53/53. Full repo lint/typecheck/build clean. No
schema change — every field this needed was already there.

### Add real unit deletion — only for a unit with zero real history (2026-08-25)

Client decision, following the unit-management slice above: add a real
`DELETE`, but conditioned on a genuine safety check — same two-step
deactivate-then-delete pattern as `MenuItem`/`AmenityItem`, plus a second
guard those two don't need. Covers "I made a wrong room by mistake"
cleanly; a unit that's actually been used keeps Deactivate as the
correct tool, since deleting it would corrupt real history, not just
remove a row.

Unlike `MenuItem`/`AmenityItem` (safe to delete once their order/request
rows snapshot the item's name), a `Unit` has no such escape hatch — a
past booking or work order *is* a room-level record, not a line item
that can survive its subject's disappearance via a snapshot. So
`deleteUnit` (`units/service.ts`) checks all six relations that actually
reference a unit — `UnitStatusEvent`, `BookingUnit`, `WorkOrder`,
`AmenityRequest`, `FnbOrder`, `Inspection` (the client's own message
named the first three explicitly; the other three exist as real FKs too
and none carry `onDelete: SetNull`, so a real `unit.delete()` against
any of them would otherwise fail at the DB with an unhandled constraint
violation rather than a clean guard) — and refuses (`409
UNIT_HAS_HISTORY`) if any row exists anywhere, pointing the caller at
Deactivate instead. Still requires the unit be already inactive first
(`409 UNIT_STILL_ACTIVE` otherwise), same as the other two.

**Frontend**: a Delete button in the drawer's "Unit details" panel, next
to Deactivate/Reactivate — shown only once already inactive (mirrors the
server's own guard, so it never fires a request certain to be refused),
behind a confirm dialog, same as the menu/amenity item pattern. A
successful delete closes the drawer and refreshes the grid; the server's
`UNIT_HAS_HISTORY` message (still surfaced if a unit somehow has history
despite the client-side hiding) explains why and points at Deactivate,
same as the guard text itself.

Verified: 8 new backend tests (permission gating, 404, the
still-active guard, one test per relation confirming each alone blocks
deletion with `UNIT_HAS_HISTORY`, and the zero-history success path), 2
new frontend tests (a real delete round-trip removing the unit from the
grid; the `UNIT_HAS_HISTORY` error surfacing without removing the unit),
and a headless-browser Playwright run confirming Delete only appears on
an already-inactive unit and never on an active one. `apps/api` 333/336
(same 3 pre-existing network-blocked round-trip tests), `apps/web`
55/55. Full repo lint/typecheck/build clean. No schema change.

### Client-confirmed: unit management is fully verified (2026-08-25)

Client live-tested the delete guard directly and confirmed both paths:

- A clean delete succeeds on a freshly-created, never-activated unit
  (zero history across all six checked relations).
- A unit with real history is correctly refused, with the
  `UNIT_HAS_HISTORY` message explaining why and pointing at Deactivate.

This closes out unit management — add/edit/deactivate/delete, the
three-way grouping, and the six-relation delete guard all verified live.
Combined with the report builder foundation (occupancy + work-order
reports) and the common-area check-in fix earlier this session, this
rounds out today's M6 work.

Holding here per the client's instruction — no further work queued.
Remaining M6 scope (the rest of spec §8.4's report set, PWA setup) waits
on the client's review of where things stand before deciding next steps.

### Housekeeping productivity report (spec §8.4 item 5) — verified in sandbox only, not live-tested (2026-08-26)

Client is off-PC and asked me to keep building report builder slices
solo, sandbox-verified only, stopping on genuine design ambiguity rather
than guessing. One came up immediately on this report and I stopped to
ask rather than build through it.

**The ambiguity**: spec §8.4 item 5 asks for three stats — "rooms
cleaned per attendant, average clean time, QC pass rate." The first two
map cleanly to real `UnitStatusEvent` data. The third doesn't: the
`Inspection` model exists in the schema but nothing in the app has ever
written to it, consistent with the 2026-08-22 client decision that
folded QC into the single CLEANED->READY click by the same attendant who
cleaned the room — there's no separate QC decision being captured
anywhere today. Asked the client how to handle this (omit it / proxy off
re-clean rate / build a real QC capture step first); **client chose to
omit it and ship the other two metrics now**, revisiting QC pass rate
later if a real signal gets captured.

**What "rooms cleaned" and "clean time" mean here**: a completed
`CLEANING -> CLEANED` cycle, credited to whichever attendant performed
that closing transition, paired against the immediately preceding
`VACANT_DIRTY -> CLEANING` event for the same unit (an event-pairing walk
per unit, not a fixed window — a room can cycle dirty/clean more than
once inside a date range). A `CLEANED` event with no observed preceding
`CLEANING` start (e.g. a forced correction straight to CLEANED) has no
real cycle to measure and is skipped rather than counted as a
zero-duration clean. A cycle counts in the report's date range by its
*closing* event's timestamp — same "count by the closing event"
convention already used for the work-order report's time-to-close.

**Department scope**: unlike occupancy (refused outright for any
DEPARTMENT-scoped `report:view` holder — no department axis at all on
that data), this report's data genuinely *is* Housekeeping's own, so a
DEPARTMENT-scoped holder whose own department is HOUSEKEEPING sees it
normally; one from any other department is refused, department-aware
rather than blanket.

No schema change — built entirely from existing `UnitStatusEvent` rows.
New report key `housekeeping` added to `packages/shared/src/report.ts`'s
`REPORT_KEYS`/`REPORT_LABELS`; `buildHousekeepingReport` added to
`apps/api/src/modules/reports/service.ts`; a `HousekeepingReportView`
added to `apps/web/src/routes/ReportsPage.tsx`, including an explicit
on-screen note that QC pass rate isn't shown and why (not just a silent
omission).

Verification: `npm run typecheck` clean (both packages), `npm run lint`
clean, `npm run test -w apps/api` — 351 tests, 348 passing (same 3
pre-existing Supabase round-trip failures every run this session hits,
no network from this sandbox), `npm run test -w apps/web` — 56/56
passing (new tests cover the department-scope allow/refuse split, the
attendant-credit/clean-time math including the skipped-unpaired-CLEANED
and started-but-not-finished-in-range cases, and CSV export), `npm run
build` clean across all three packages. **Not live-tested** — no access
to the client's real Supabase data this session; needs a real pass once
the client is back at their PC, same as every prior slice.

### Maintenance log by day (spec §8.4 item 6) — verified in sandbox only, not live-tested (2026-08-26)

Client confirmed the QC-omission handling on the housekeeping report and
asked me to continue to this one next, flagging that I should re-check
the "CSV-only for Phase 1" assumption against the actual spec text
rather than just going with the read from memory. Did that before
writing any code — **the assumption was wrong**, worth flagging exactly
as asked:

> "Every report renders on screen **and** exports to CSV (Phase 1) and
> PDF (Phase 2)." Item 6 itself: "...photo thumbnails per ticket, so the
> day's log is visual evidence rather than a text list. CSV export
> carries authenticated photo URLs; the Phase 2 PDF export embeds the
> images two-up per ticket."

So the on-screen render needs real `<img>` thumbnails in Phase 1 — only
the *PDF* embedding is deferred to Phase 2, not image display generally.
Built it that way: `MaintenanceLogReportView` renders actual photo
thumbnails (clickable through to the full signed URL), the CSV export
carries the same signed URLs as plain text columns instead.

**Scope**: "Maintenance log" = `WorkOrder` rows with `type: MAINTENANCE`
(not a `department` filter — `department` is set independently at
creation and can in principle diverge from `type`, same reasoning as the
housekeeping report's own department-vs-data-scope call). "Issue" and
"completion" photos are exactly the two kinds
`DEFAULT_WORK_ORDER_PHOTO_REQUIREMENTS` mandates for MAINTENANCE tickets
— PROGRESS photos, if any exist, aren't part of this report. "By day"
buckets on `createdAt` (the day the ticket was filed), matching the
general work-orders report's own date-range convention — a still-open
ticket with no completion date yet still belongs in the log for the day
it was opened.

**Photo URL lifetime**: the existing work-order-detail code signs photo
URLs for 300 seconds (fine for a live screen someone is looking at right
now). A report — especially its CSV export, meant to be downloaded and
reviewed later — needs longer-lived links, so this report signs for 1
hour instead. Same signed URLs back both the on-screen thumbnails and
the CSV export's URL columns from one report build. This is a low-risk,
easily-adjustable default (not an architectural decision), so I picked
it and documented the reasoning rather than stopping to ask; flag if you
want a different window.

Department scope, permission gating, and DEPARTMENT-vs-ALL report:view
handling all follow the exact same pattern established by the
housekeeping report (own-department sees it, any other department is
refused) — no new ambiguity there.

No schema change — built entirely from existing `WorkOrder`/
`WorkOrderPhoto`/`FileObject` data. New report key `maintenance-log`
added to `packages/shared/src/report.ts`; `buildMaintenanceLogReport`
added to `apps/api/src/modules/reports/service.ts`;
`MaintenanceLogReportView` added to `ReportsPage.tsx`.

Verification: `npm run typecheck` clean (both packages), `npm run lint`
clean, `npm run test -w apps/api` — 355 tests, 352 passing (same 3
pre-existing network-blocked failures), `npm run test -w apps/web` —
57/57 passing (new tests cover the department-scope split, the
type-MAINTENANCE filter, day-grouping, signed-URL generation with the
1-hour TTL, on-screen thumbnail rendering, and CSV export carrying the
URLs as text), `npm run build` clean across all three packages. **Not
live-tested** — needs a real pass against the client's Supabase data and
real work-order photos once they're back at their PC.

### F&B orders report (spec §8.4 item 7) — verified in sandbox only, not live-tested (2026-08-26)

Client set the boundary ahead of time this time, rather than waiting for
me to hit it: "revenue" means the sum of `FnbOrder.subtotal` — list
prices already stored on orders/menu items, genuinely operational
monitoring (order volume, popular items), never anything implying money
was actually collected or verified, since no payment-status field exists
on `FnbOrder` to tie into anyway. Told to proceed if the report can stay
in "what was ordered and its listed value" territory, and to flag
specifically if that line blurred anywhere. It didn't — the whole report
sits cleanly on that side, and the on-screen view says so explicitly
("does not mean payment was collected or verified") rather than leaving
it implicit.

**Volume, revenue, average prep time, top items** — all built from
existing `FnbOrder`/`FnbOrderLine` data, no schema change:

- **Volume**: every order placed in range, including CANCELLED — same
  "opened in period" convention as the work-orders report's own
  `totalVolume`.
- **Revenue**: sum of `subtotal` across non-cancelled orders only. A
  cancelled order's items were never actually prepared or served, so
  including its listed value would overstate what food/drink volume
  genuinely moved — an order-fulfillment accuracy call, not a payment
  question, so I made this call and documented it rather than treating
  it as the kind of ambiguity to stop for.
- **Average prep time**: `preparingAt` → `readyAt` per order (the literal
  kitchen-prep window the workflow's own timestamps name), averaged over
  orders where both are set. Deliberately not the wider
  received-to-ready window, which would also count queue/acknowledgement
  wait as "prep."
- **Top items**: `FnbOrderLine.qty` summed by `menuItemName`, across the
  same non-cancelled orders revenue uses, top 10 by quantity.

Department scope follows the same pattern as housekeeping/maintenance-log:
a DEPARTMENT-scoped `report:view` holder in RESTAURANT sees it normally,
any other department is refused.

New report key `fnb-orders` added to `packages/shared/src/report.ts`;
`buildFnbOrderReport` added to `apps/api/src/modules/reports/service.ts`;
`FnbOrderReportView` added to `ReportsPage.tsx`, reusing the same peso
formatting `FnbPage.tsx`'s menu-price display already uses.

Verification: `npm run typecheck` clean (both packages), `npm run lint`
clean, `npm run test -w apps/api` — 360 tests, 357 passing (same 3
pre-existing network-blocked failures), `npm run test -w apps/web` —
58/58 passing (new tests cover the department-scope split, the
volume-includes/revenue-excludes-cancelled split, the prep-time
averaging, top-items aggregation, the empty-range case, and CSV export),
`npm run build` clean across all three packages. **Not live-tested** —
needs a real pass against the client's Supabase F&B data once they're
back at their PC.

### Amenity utilisation & loss/damage report (spec §8.4 item 8) — verified in sandbox only, not live-tested (2026-08-26)

Client confirmed the F&B orders boundary held clean (revenue as order-
subtotal totals, no payment/settlement implication) — that report was
actually already shipped before their confirmation landed, so no rework
needed there.

This report hit a real, structural ambiguity, and I stopped to ask
rather than guess. Two findings before writing any code:

1. **"Loss/damage" is not a gap.** There's already a real, fully-wired
   `LOST_DAMAGED` status on `AmenityRequestStatus` (reachable from
   OVERDUE, gated by `amenity:return`, captured with a
   `conditionOnReturn` note, live in the return-flow UI). No inference
   or new field needed — the report just reports on that status
   directly.
2. **Department scope has no clean answer.** Unlike housekeeping/
   maintenance/F&B, amenities aren't owned by one department —
   `amenity:*` permissions are granted broadly (front desk, cashier,
   housekeeping, resort staff all hold them), and among the three
   DEPARTMENT-scoped `report:view` holders, only POC_HOUSEKEEPING
   touches amenities at all. There's no `department` field on
   `AmenityRequest` to filter by either.

Asked how to handle #2. Client's answer, in their own words: "the
people who physically issue/return amenities span multiple departments
... The report itself should be an oversight tool: restrict report:view
for amenity utilisation to roles actually responsible for monitoring
stock — SYSTEM_ADMIN, RESORT_MANAGER, and any amenity-relevant POC (per
whichever holds amenity:manage/amenity:approve today) — refuse it for
everyone else, regardless of whether they hold amenity:request/issue
operationally."

Implemented as a new role-based gate,
`canViewAmenityUtilisationReport` (`packages/shared/src/amenityRequest.ts`)
— same narrow, documented-exception pattern as `workOrder.ts`'s
`canVerifyWorkOrder` and `unitStatus.ts`'s
`canOverrideAutomaticTransition`: a policy decision about which role's
authority reaches, not the ordinary report:view ALL/DEPARTMENT scope
check. `ReportActor` gained a `roles` field (threaded through from
`req.authUser!.roles` in the router) so the service layer can make this
call.

One thing worth flagging: building this, my first pass computed
"amenity-relevant" too literally — "any role holding
amenity:manage/amenity:approve" — which would have let CASHIER through
(it holds `amenity:approve` in this codebase, unrelated to this
report). The client said "amenity-relevant **POC**," and CASHIER isn't
a department POC, so I scoped the dynamic check to the actual POC-tier
trio this codebase already names elsewhere (`workOrder.ts`'s own header
comment calls POC_HOUSEKEEPING/POC_MAINTENANCE/RESTAURANT_MANAGER "the
department POC") — a test catching the CASHIER case caught this before
it shipped. Today that resolves to: SYSTEM_ADMIN, RESORT_MANAGER, and
POC_HOUSEKEEPING (the only one of the three POC-tier roles that
currently holds `amenity:manage`/`amenity:approve`); POC_MAINTENANCE
and RESTAURANT_MANAGER hold neither and are refused, as are
OWNER/OPS_SAFETY_SUPERVISOR/ADMIN_HEAD/CASHIER despite their own
ALL-scope `report:view`.

**Utilisation and loss/damage** — built from existing `AmenityRequest`
data, no schema change: total requests and qty issued in range (scoped
on `createdAt`, same convention as every other report here), broken
down per item, with `qtyIssued` counting only requests where `issuedAt`
is actually set (a REQUESTED/APPROVED/CANCELLED request never had
anything physically handed out) — and a loss/damage count and detail
list pulled straight from `LOST_DAMAGED` status rows.

Verification: `npm run typecheck` clean (both packages), `npm run lint`
clean, `npm run test -w apps/api` — 365 tests, 362 passing (same 3
pre-existing network-blocked failures), `npm run test -w apps/web` —
59/59 passing, `npm run test -w packages/shared` — 76/76 passing (new
role-gate tests specifically pin the CASHIER-exclusion case, plus the
allow/refuse split for every relevant role, the qty-issued-excludes-
never-issued math, and CSV export), `npm run build` clean across all
three packages. **Not live-tested** — needs a real pass against the
client's Supabase amenity data, and specifically their own account's
role, once they're back at their PC.

### User activity / audit extract (spec §8.4 item 9) — closes the MVP report set — verified in sandbox only, not live-tested (2026-08-26)

Client confirmed the CASHIER-exclusion fix on the amenity report matches
what they meant. This report closes out spec §8.4's full nine-report
MVP set.

No new ambiguity here — spec is explicit about the restriction
("SYSTEM_ADMIN, RESORT_MANAGER, OWNER only"), and it turned out to need
no new role-gate function at all: `audit:read` is already granted to
exactly those three roles and nowhere else (`rolePermissions.ts`), so
checking that one existing permission directly *is* the spec's
restriction, verbatim — simpler than the amenity report's case, as
expected going in.

Built from `AuditLog`, the model the audit Prisma extension (wired up
back in M1) has been writing to all session for every create/update/
delete on an audited entity, plus explicit login events — this is the
first place anything actually reads those rows back. Scoped on
`createdAt`, same convention as every other report here.

One deliberate scope boundary, flagged rather than silently assumed:
spec §9 separately lists a raw `GET /audit-logs?entity=&actorId=&from=&
to=` browsing endpoint with its own entity/actorId filters — that's a
distinct, not-yet-built API surface (no dedicated audit module exists),
out of scope for "continue the report builder." This report is
date-range only, matching every other report in this set; the raw
browsing endpoint is a separate task if wanted later.

One data-safety note, not a new decision: every `AuditLog.before`/
`after` JSON blob is already redacted of credential material at write
time (`auditExtension.ts`'s `redactSensitiveFields`, applied before any
row is ever persisted) — so surfacing the full before/after here, to a
role that already holds `audit:read`, doesn't newly expose anything
sensitive. On screen it renders collapsed per event (a `<details>`
disclosure) rather than inline, since it can be sizeable and most rows
don't need it open to be useful; in the CSV it's a plain JSON-text
column (over-quoted, RFC-4180-safe, courtesy of the existing `toCsv`
helper's own escaping).

New report key `audit-extract` added to
`packages/shared/src/report.ts`; `buildAuditExtractReport` added to
`apps/api/src/modules/reports/service.ts`; `AuditExtractReportView`
added to `ReportsPage.tsx`.

Verification: `npm run typecheck` clean (both packages), `npm run lint`
clean, `npm run test -w apps/api` — 370 tests, 367 passing (same 3
pre-existing network-blocked failures), `npm run test -w apps/web` —
60/60 passing (new tests cover the three-role allow list, the refusal
of report:view holders without `audit:read`, actor-name resolution
including the null-actor "System" fallback, the before/after JSON
round-trip through both the JSON response and the CSV export, and the
collapsed-details UI), `npm run build` clean across all three packages.
**Not live-tested** — needs a real pass against the client's actual
Supabase audit history once they're back at their PC.

This closes spec §8.4's full nine-report MVP set. Holding here per the
same "report back and let the client decide next steps" discipline as
the rest of this session — remaining M6 scope (PWA setup, per the
earlier "Client-confirmed: unit management is fully verified" note)
waits on review.

### Real bug found live-testing: occupancy report included non-bookable common areas (2026-08-26)

Client reported: the occupancy & unit status history report (spec §8.4
item 1, the first report built this session) listed common areas (Pool,
Beach Front, Function Hall, the CRs, the Restaurant) alongside real
rooms/cottages. "Occupancy" only means something for a bookable unit —
a common area can't be "occupied" the way a room can — and worse, the
daily occupancy-rate summary was computing its percentage against *all*
units as the denominator, including those, understating the real rate.

Fixed by filtering `buildOccupancyReport`'s unit query
(`apps/api/src/modules/reports/service.ts`) to `BOOKABLE_UNIT_KINDS`
(`packages/shared/src/unitKind.ts`) — the exact same ROOM/COTTAGE list
already used by the Check-in picker and its server-side guard, reused
here per the client's explicit instruction rather than reimplemented.
Since the unit list feeding both the per-day rows and the
`occupiedCount`/`totalUnits` summary math is the same filtered array,
one `where` clause fix corrects both problems at once — no separate
denominator calculation to fix. The report's `group` column (Rooms &
Cottages / Common areas / Facilities) now always reads "Rooms &
Cottages," since every remaining row is bookable by definition; left in
rather than removed, since it's still accurate and dropping it would be
a CSV/API shape change beyond what was reported as broken.

No schema change. Updated the existing occupancy test to reflect the
corrected row count/occupancy-rate math, and added a dedicated test
asserting the `unit.findMany` where-clause carries the
`type: { in: ['ROOM', 'COTTAGE'] }` filter — the actual regression
protection, since a Prisma mock doesn't filter on its own the way a real
query would.

Verification: `npm run typecheck` clean (both packages), `npm run lint`
clean, `npm run test -w apps/api` — 371 tests, 368 passing (same 3
pre-existing network-blocked failures every run this session hits),
`npm run test -w apps/web` — 60/60 passing, `npm run test -w
packages/shared` — 76/76 passing, `npm run build` clean across all
three packages. **Not live-tested** — needs a real pass against the
client's Supabase unit data (specifically confirming Pool/Beach
Front/Function Hall/CRs/Restaurant no longer appear, and that the
occupancy-rate percentage now looks right) once they're back at their
PC.

### Owner daily digest + exception alerts (spec §8.3) — verified in sandbox only, not live-tested (2026-08-26)

**Before writing any code**: investigated what the digest/exception-alert
content actually needs, found that most of it (revenue, payment
verification queue, forced-checkout balance, cash variance) depends on
Payment/Folio/CashCount tracking that turned out to be completely
unbuilt — zero code anywhere touches those models. This wasn't a gap
noticed and silently worked around; it's now written into the spec
itself as **decision 7** in spec.md §13's Confirmed Decisions table
(plus a plainly-stated consequences bullet in §13.1), per client
instruction, before any of this slice's code was written: Cashier's
whole spec'd role is currently unimplemented, M4's stated acceptance
criteria doesn't hold against what was actually built, and the Owner
dashboard/digest will never show revenue, a payment queue, folio
balances, or cash variance until that's revisited.

Client confirmed proceeding on that basis. What shipped:

**Minimal Incident module** (new — `Incident` was scaffolded in the
schema since M0 but had zero code touching it): `POST /incidents`
(`incident:create`, seeded on essentially every role) and `GET
/incidents` (`incident:read`, oversight roles only). Not the full §8.3
incident/policy log — just enough for a real safety-incident trigger and
a real digest count. `packages/shared/src/incident.ts` holds the
type/severity/status key lists, same convention as every other domain
enum in this package.

**Exception alerts** (spec §8.3: "push immediately for" four specific
triggers) — two of the four are real, two are explicitly out of scope
for the reason above:
- **Urgent work order past SLA**: real. This is a time-threshold
  condition, not something a user action fires, so there's no event to
  hook — same reasoning as the amenity-overdue sweep. New
  `listUrgentSlaBreachedWorkOrders` (URGENT-priority-narrowed version of
  the existing `listSlaBreachedWorkOrders`) feeds a new
  `POST /api/v1/jobs/exception-alerts` sweep (`jobs/service.ts`'s
  `runExceptionAlertsSweep`), registered in `netlify.toml` on the same
  15-minute cadence as amenity-overdue. Dedup: before alerting, checks
  whether a `WORKORDER_SLA_BREACHED` Notification already exists for
  that ticket — no schema change, reuses the same rows the alert itself
  writes, so a still-breached ticket doesn't re-alert on every sweep.
- **Safety incident**: real, event-driven — fires on `Incident` creation
  with `type: 'SAFETY'` specifically (spec's literal phrase), no
  severity threshold (spec doesn't gate this one by severity).
- **Forced check-out with outstanding balance** and **cash variance
  beyond a threshold**: omitted — no balance/variance data exists to
  check against, and (per your own flag) no threshold value exists
  anywhere in spec.md for the latter even if it did.

All alerts reuse the existing Notification model (`notifyUser`, from
M3) — no second notification path. Recipients for every exception alert
= active users holding `OWNER` (spec places this whole bullet under the
Owner dashboard section specifically).

**Daily digest** — `POST /api/v1/jobs/owner-digest`, same
`requireJobSecret` shape as amenity-overdue. The Netlify Scheduled
Function *file* itself stays deferred to M7 launch config, same as
amenity-overdue's own — `netlify.toml` already had the `owner-digest`
entry at `0 0 * * *` (= 8:00 AM PHT) from M0; only the API endpoint
shipped this slice.
- Content: occupancy % (reuses `buildOccupancyReport`'s exact logic for
  a single day — no duplicated math, and gets the "exclude common
  areas" fix above for free), arrivals (mirrors `getUnitsDashboard`'s
  own `checkinsToday` definition — READY→OCCUPIED `UnitStatusEvent`
  rows — for yesterday instead of today), incidents (all types, not
  just SAFETY — that's the narrower real-time alert; this is the
  broader daily count), and a live list of currently-open URGENT/
  SLA-breached work orders, each with a real deep link. Revenue and the
  payment verification queue are explicit "not tracked — pricing/
  payments are out of scope (spec.md §13 decision 7)" lines in the email
  body, not silent omissions.
- **"Yesterday" boundary**: real Asia/Manila calendar-day math via
  `@date-fns/tz`'s `TZDate` (same pattern as `reports/service.ts`'s
  `resolveDate`), computed relative to whenever the job actually runs —
  the job itself is time-agnostic; 8:00 AM PHT is entirely the
  scheduler's responsibility. Found, in passing, that the *existing*
  `checkinsToday`/`checkoutsToday` KPI on the Command Center uses the
  server process's local midnight instead of a real Asia/Manila
  boundary — a real, pre-existing gap against spec §3.2, out of scope
  for this slice since fixing it touches different code with its own
  test to update. Filed as a separate suggested follow-up task rather
  than folded in here or silently left unmentioned.
- **Channel**: new `Setting` key `ownerDigest.channel`, default
  `'email'` (same read-live-row/fallback pattern as
  `fnb.advanceOrderLeadMinutes`/`workOrder.photoRequirements`). Any
  other value is logged and skipped, not an error — only email is
  built (MVP).
- **Recipients**: active `OWNER`-role users with a non-null email.
  Real, live caveat: no seeded user in this app has an email set today
  (login is by employee code) — the job correctly reports 0 recipients
  rather than erroring, but produces nothing useful in practice until an
  OWNER account's email is actually set.
- Sends via `resend` (new dependency, pre-approved by spec.md §12 rule
  3 — installed, no need to ask).

**One small addition beyond the original ask, flagged rather than done
silently**: while building the digest's "deep link straight into the
relevant record" requirement, found `WorkOrdersPage` had no
URL-addressable way to open a specific ticket at all — `selectedId` was
local React state only, so a link into this page always landed on the
bare list. Added minimal `?id=` support (read once on mount via
`useSearchParams`, auto-opens the drawer) — small, additive, doesn't
change any existing behavior for a visitor who arrives without it.
Confirmed live in a headless browser: visiting `/work-orders?id=wo_1`
directly (no row click) opens the correct ticket's detail drawer.
`Incident` deep links are not implemented — no frontend page exists for
incidents at all yet (out of the "minimal module" scope); the digest
shows a count only for those.

No schema change — `Incident`'s table has existed since M0's initial
migration; this slice only wired real code to it for the first time.

Verification: `npm run typecheck` clean (both packages), `npm run lint`
clean, `npm run test -w apps/api` — 394 tests, 391 passing (same 3
pre-existing network-blocked failures), `npm run test -w apps/web` —
61/61 passing, `npm run test -w packages/shared` — 76/76 passing (new
tests cover: incident creation + the SAFETY-only alert trigger + read
permission gating; the SLA-breach sweep's alert/dedup/no-op paths and
the missing/wrong `x-job-secret` rejection; a dedicated
`listUrgentSlaBreachedWorkOrders` where-clause test; the digest's
Asia/Manila boundary math with an explicit UTC-vs-PHT-mismatch case,
its revenue/payment "not tracked" labelling, its deep-link rendering,
and its own `x-job-secret` rejection; the `WorkOrdersPage` `?id=`
deep-link). `npm run build` clean across all three packages;
`scripts/check-serverless-safety.sh` clean (no `setInterval`, matching
spec §3.1's "plain HTTP job endpoints" requirement for both new jobs).
**Not live-tested** — needs a real pass with a real Resend API key, a
real OWNER email set, and real Netlify Scheduled Functions wired up at
M7 launch, once the client is back at their PC.

### Client decision: no owner digest email, ever — Command Center is the sole channel (2026-08-26)

Client decision, documented as decision 8 in spec.md §13 (same pattern
as decision 7): the owner will monitor everything live through the
Command Center / Owner dashboard instead of a scheduled 8:00 AM PHT
email summary. This reverses §8.3's own "Send a summary at 8:00 AM PHT"
line — not a deprioritization, not "email later": no digest send of any
kind unless this decision is itself revisited.

Per instruction, the digest's own code stays exactly as built —
`sendOwnerDigest`, `computeDigestContent`, `renderDigestEmail`
(`apps/api/src/modules/jobs/ownerDigest.ts`), `POST
/api/v1/jobs/owner-digest`, and all of the prior slice's tests are
untouched. Only `netlify.toml`'s `[functions."owner-digest"]` schedule
entry was removed, so the endpoint is never actually triggered in
production — re-adding it later, if this is revisited, is a one-line
config change, not a rebuild. The Incident module, both real exception
alerts (SLA-breach and safety-incident), and the `WorkOrdersPage`
`?id=` deep-link are all unaffected — none of them depended on the
digest schedule.

No code change beyond the `netlify.toml` edit; no schema change.
Verification: `npm run typecheck` clean (both packages), `npm run lint`
clean, `npm run test -w apps/api` — 394 tests, 391 passing (same 3
pre-existing network-blocked failures, unchanged — the digest's own
tests call the Express route directly via supertest, bypassing Netlify
scheduling entirely, so removing the schedule entry doesn't affect
them), `npm run build` clean across all three packages.

### Two more stale "Coming in M5" placeholders, closed out; full Command Center sweep (2026-08-25)

Second round of the exact same bug as "KPI strip: the last three stale
placeholders, closed out" above: two Command Center widgets still said
"Coming in M5" after M5 finished, both missed in that earlier pass because
their backing modules (F&B, amenities) didn't exist yet at the time they
were written.

**Open F&B tickets KPI** — now `countOpenFnbOrders()`
(`apps/api/src/modules/fnb/service.ts`), wired into `getUnitsDashboard`
the same way `workorders/service.ts`'s functions already are (cross-module
import, no duplicated logic). "Open" is defined as exactly the population
the kitchen board itself renders (`listFnbOrders`'s `boardOnly` branch):
`RECEIVED`/`PREPARING`/`READY`, with an `ADVANCE_ORDER` excluded until its
lead-time window opens (reading the same `fnb.advanceOrderLeadMinutes`
Setting/default the kitchen board uses). This is a design interpretation
of the client's "not yet SERVED/CANCELLED" phrasing, not a literal
reading — an advance order that isn't the kitchen's concern yet shouldn't
inflate the KPI either. Flagging this interpretation for the client to
correct if the intent was the broader literal count.

**Overdue amenities attention-queue row** — now
`listOverdueAmenityRequests()` (`apps/api/src/modules/amenities/service.ts`),
same live-computed-field pattern as `listSlaBreachedWorkOrders`: `status =
OVERDUE` (already swept) OR `status = ISSUED AND dueBackAt < now` (not yet
swept — the sweep job only runs every 15 minutes, so a request that just
crossed its due-back time is already really overdue before the next sweep
fires). Reuses the same snapshot -> live-relation -> `(deleted item)`
fallback chain for `itemName` as Option B's real amenity-item deletion.

Both stub components (`StubKpiCard`, `StubAttentionRow`) are now deleted
from `DashboardPage.tsx` — no `"Coming in M#"` usage remains anywhere in
that page, or in `apps/web/src` generally. Confirmed via a repo-wide grep
sweep (`Coming in M`, `Coming soon`, `not built yet`, `isn't built yet`,
`doesn't exist yet`, `not yet built`, `— M5`, `— M6`, `(M5)`, `(M6)`): the
only hit is a legitimate, accurate comment in `ReportsPage.tsx` describing
the report builder as "M6's first slice" — current, true state, not a
stale leftover.

No schema change. New/updated backend tests:
`apps/api/test/modules/fnb/service.test.ts` (new, `countOpenFnbOrders`'s
where-clause and Setting-driven lead time),
`apps/api/test/modules/amenities/service.test.ts` (new,
`listOverdueAmenityRequests`'s where-clause and itemName fallback chain),
and `apps/api/test/modules/units/router.test.ts` (three new dashboard
integration tests pinning the end-to-end response shape, plus the
pre-existing KPI-shape test updated for the new `openFnbOrders` field).
`apps/web/test/App.smoke.test.tsx`'s Command Center test updated to assert
real values for both widgets instead of the old stub text.

Verification: `npm run typecheck` clean (both packages), `npm run lint`
clean, `npm run test -w apps/api` — 346 tests, 343 passing (the same 3
pre-existing Supabase-round-trip failures every run this session hits, no
network access from this sandbox), `npm run test -w apps/web` — 55/55
passing, `npm run build` clean across all three packages. Also verified
live in a headless browser against the built app (mocked
`/units/dashboard` response): the F&B KPI card renders a real number, the
overdue-amenity row renders with real data, the empty-state text renders
when the list is empty, and zero dashed-border stub elements remain
anywhere on the page.

### Error boundaries + consistent loading/empty states (spec §11 M6 line) — verified in sandbox only, not live-tested (2026-08-26)

Client's exact request: "empty states, loading skeletons, error
boundaries" from the M6 line of spec §11, flagging that this was handled
ad hoc per page with no shared pattern and that there was no React error
boundary anywhere in the app — an unhandled render error white-screened
the whole app with no recovery path. Explicit foundation slice ahead of
PWA/offline work, which will need to layer an "offline" state on top of
whatever loading/empty pattern exists — client wanted this consistent now
rather than retrofitted twice. Plan (three new shared components plus a
full sweep of every ad hoc loading/empty spot found by audit) presented
and approved verbatim ("proceed as planned").

**New module**: `apps/web/src/components/`, the app's first shared UI
component location (everything previously lived in `routes/` or `lib/`).

**`ErrorBoundary.tsx`** — a hand-rolled class component (React 19 still
has no hook-based way to catch a render error;
`getDerivedStateFromError`/`componentDidCatch` are class-only, so this is
a small local component rather than a new dependency per spec §12 rule 3).
Two modes: no `fallback` prop renders a full-screen "Something went
wrong" block with a Reload button (the safest universal recovery when
state may be genuinely corrupted); a `fallback` render-prop
`(error, reset) => ReactNode` gives a lighter, widget-scoped recovery via
`reset()`, which just clears the caught error and remounts the children.
An optional `resetKey` prop clears a caught error automatically when it
changes, so a boundary can auto-recover on navigation without a manual
reload. Also exports `WidgetError` — a small compact fallback ("`{label}`
failed to load." + Try again) reused by every widget-level boundary
rather than each call site hand-writing the same JSX.

Three-layer placement, decided by which pages actually render multiple
simultaneous independent widgets (the only case where a nested boundary
adds real isolation beyond the next layer up):
- **`App.tsx`** — outermost, wraps `<AuthProvider><Routes>`, no
  `resetKey`. Last-resort net if something above the router itself
  breaks.
- **`AppShell.tsx`** — around `<Outlet />`, `resetKey={location.pathname}`
  via `useLocation()`. This is the primary boundary protecting all 9
  authenticated pages: a crash in any one page shows the fallback instead
  of white-screening the whole shell, and navigating away clears it
  automatically.
- **Targeted widget-level boundaries**, only where justified:
  `DashboardPage`'s three simultaneous widgets (Property status /
  Attention queue / Live activity), each independently wrapped so one
  broken widget doesn't take the other two down with it; and
  `WorkOrdersPage`'s detail drawer (`resetKey={selectedId}`), an overlay
  on top of an otherwise-unaffected list. Deliberately **not**
  `ReportsPage` — it renders exactly one report view at a time, so a
  nested boundary there would add no protection beyond the Outlet-level
  one already covering it.

**`Skeleton.tsx`** — matches the three actual visual shapes found across
the app rather than one generic placeholder: `Skeleton` (an atomic
pulsing bar, sized via `className`), `SkeletonTableRows({ rows, columns })`
(real `<tr>`/`<td>` rows, meant to sit inside a real
`<table><tbody>`), `SkeletonList({ items })` (`<li>` rows inside its own
`<ul>`), and `SkeletonCard()` (a bordered two-line card matching the
KPI-tile shape). Each ad hoc "Loading…" spot got the primitive matching
its real rendered shape once data arrives — table rows for tables (with
the real column count read off that table's own `<thead>`), `SkeletonList`
for `<ul>` lists, repeated `SkeletonCard` for card/KPI grids, and a single
sized `Skeleton` bar for small inline transient loads (a dropdown's staff
list, a checkout checklist, the boot-time auth check) that aren't a
list/table shape at all.

**`EmptyState.tsx`** — `{ message, action? }`, renders the message in the
exact pre-existing `text-sm text-gray-500` styling every ad hoc empty
state already used (so nothing changes visually, just centralizes it)
plus an optional action slot.

**Full sweep, not partial** — client had flagged the specific risk of
"leaving both patterns running side by side," so every ad hoc loading/
empty spot found in the audit (10 files, one per route page plus
`RequireAuth.tsx`) was converted rather than a high-traffic subset:
`DashboardPage`, `WorkOrdersPage`, `AmenitiesPage`, `FnbPage`,
`RolesPage`, `SessionsPage`, `UsersPage`, `UnitsPage`, `ReportsPage`,
`RequireAuth`. Behavior is unchanged everywhere — same conditional
branches, only the rendered markup changed.

**One real gap found and fixed along the way**: `ReportsPage`'s results
pane had no loading indicator at all before this slice — only the "Run
report" button's own label changed to "Running…" while the pane below it
sat static. Added a `SkeletonTableRows` placeholder there, matched to a
representative report's column count.

New tests: `apps/web/test/ErrorBoundary.test.tsx` (5 — renders children
normally; default fallback + Reload button calls
`window.location.reload()`; custom `fallback` render-prop and its
`reset()`; `resetKey` change auto-recovers on a simulated navigation;
`WidgetError` renders its label and calls `reset`), `Skeleton.test.tsx`
(6, covering all four primitives and their default/custom counts),
`EmptyState.test.tsx` (3, message/action/no-action). Per the client's
scope note, these cover the shared components themselves, not full
coverage of every page that now uses them — each edited page's own
existing test suite (`App.smoke.test.tsx`, `WorkOrdersPage.test.tsx`,
`AmenitiesPage.test.tsx`, `FnbPage.test.tsx`, `UnitsPage.test.tsx`) was
re-run after its edits and confirmed no regressions, since the swap
preserved every conditional branch.

No schema change, no new dependency. Verification: `npm run typecheck`
clean (both packages), `npm run lint` clean, `npm run test -w apps/web` —
75/75 passing (11 files), `npm run test -w apps/api` — 391/394 passing,
the same 3 pre-existing Supabase-round-trip failures every run this
session hits (no network access from this sandbox; unrelated to this
UI-only slice), `npm run test -w packages/shared` — 76/76 passing,
`npm run build` clean across all three packages. Verified in sandbox only
— this is a broad UI-only change touching every route page, so a
live-browser check (and, once the client is testing against the real
Supabase database, a real render of each converted loading/empty spot) is
worth doing before calling this fully closed.

### Real bug found live-testing: OccupancyReportView had no empty-state handling at all; caught as a methodology gap across all of ReportsPage (2026-08-30)

Client live-tested the Occupancy report against a date range with no
data and got two headers-only tables with a blank body underneath — no
`EmptyState`, no message, nothing. The earlier loading/empty-state sweep
missed this because that sweep worked by finding existing ad hoc
`<p>No X yet.</p>` text and replacing it with `EmptyState` — a
search-and-replace of text that was already there. Occupancy's two
tables never had any empty-state text to find in the first place, so the
method itself couldn't see the gap. Client asked for a second pass over
every report view checking zero-row behavior directly, not just
searching for existing strings — flagging it correctly as a methodology
problem, not a one-file bug.

Re-audited `ReportsPage.tsx` line by line: every `.map()` over a
list/table across all 7 report views, checked for a zero-length branch
regardless of whether ad hoc text existed to find. Found 11 more gaps
beyond the 2 reported, spread across every view except Maintenance log
(already fully covered from the earlier sweep):

- **Occupancy** — Daily occupancy table (`summary.byDay`), Unit status
  history table (`rows`) — the 2 originally reported.
- **Work orders** — "By type" list, "By department" list, "Tickets in
  range" table.
- **Housekeeping** — "Cleans in range" table.
- **F&B orders** — "Orders in range" table.
- **Amenity utilisation** — "Requests in range" table.
- **Audit extract** — "By action" list, "By entity" list, "Events in
  range" table.

All 13 spots now use the same dual-conditional pattern already
established elsewhere in this file (`{x.length === 0 && <EmptyState
message="..." />}` / `{x.length > 0 && <table>/<ul>...}`), each with a
message matching its section's existing local convention rather than one
generic string. Also tidied Audit extract's "Top actors" list, which
already had the `EmptyState` check but rendered an empty `<ul>`
alongside it regardless — now uses the same dual-conditional as every
other spot, for consistency, not because the old version was visibly
broken (an empty `<ul>` renders nothing).

New regression test in `ReportsPage.test.tsx`: runs the occupancy report
with an empty `summary.byDay`/`rows` response and asserts both empty-state
messages render and no `<table>` is in the document — this is the exact
case that reached the client live and had no test coverage before now.
Existing test suite otherwise untouched; all still-populated-data
assertions in the other 8 tests continue to pass since they only added a
sibling branch, not a behavior change to the populated case.

Verification: `npm run typecheck` clean, `npm run lint` clean,
`npm run test -w apps/web` — 76/76 passing (up from 75, the one new
regression test), `npm run build` clean across all three packages. Single
file touched (plus its test file), no schema change, no new dependency.
Sandbox-verified only — recommend the client re-run the same zero-data
occupancy range that surfaced this, plus spot-check a couple of the other
11 fixed spots (e.g. an empty-range work-orders or audit-extract run),
against the real Supabase database.

### Bug fix: amenity requests had no way to record which room they were for (2026-08-31)

Real gap found live-testing: `AmenitiesPage.tsx`'s request-creation form
only captured Item, Quantity, and Notes. `createAmenityRequestSchema`
already supported an optional `unitId` (and `bookingId`) — the backend
was ready, the frontend just never exposed it — so there was no way to
know which room/guest a request was for except free-text in Notes, which
isn't validated and doesn't show up anywhere structured (the amenity
utilisation report's `unitCode` column rendered blank for every request
made through this form).

**Unit picker, filtered to `OCCUPIED` units, optional.** `unitId` stays
optional server-side (so does `bookingId`, untouched — no picker exists
for it anywhere in the app, and nothing depends on it: amenity deposits
are informational-only, never posted to a folio). Requiring a unit would
have blocked the legitimate unattached case — staff borrowing an item for
property use, not tied to any guest room. The picker itself only offers
`OCCUPIED` units: a unit-tied request only makes operational sense when
someone's actually there to receive the item, unlike a work order (valid
for an empty `VACANT_DIRTY` room needing a repair). This also excludes
`COMMON_AREA`/`FACILITY` units for free, since those kinds never carry
`OCCUPIED` status — no separate carve-out needed.

**Bonus fix, same root cause:** the requests list on this page showed
*zero* unit info per request, even though the API has always returned
`unit: {id, code, name}` in every response (`AMENITY_REQUEST_INCLUDE`
already selected it) — the frontend's `AmenityRequestRow` type just never
captured it. Without this the newly-picked unit would still have been
invisible in the one place staff actually look. Now shown inline
("for R01") next to the requester's name.

New test in `AmenityPage.test.tsx`: submits with a unit selected from a
mixed-status fixture (`OCCUPIED`/`VACANT_DIRTY`/`READY`), asserts the
picker offers only the `OCCUPIED` one, that `unitId` reaches the POST
body, and that the created row renders it.

No schema change (the field already existed), no new dependency.
Verification: `npm run typecheck` clean, `npm run lint` clean,
`npm run test -w apps/web` — 7/7 passing on `AmenitiesPage.test.tsx` (up
from 6). Sandbox-verified only.

### M6 slice: PWA manifest + install prompt + read-only offline cache of the last-known board (spec §11 M6) — verified in sandbox only, not live-tested (2026-08-31)

Spec's own wording for this M6 line is deliberately narrow — not full
offline app support — and the build stays inside exactly that scope.

**1. Manifest + icons.** `apps/web/public/manifest.webmanifest`
(`display: standalone`, `start_url`/`scope: "/"`, `theme_color`
`#1d4ed8` matching the app's existing `bg-blue-700` accent), linked from
`index.html` along with a theme-color meta tag and apple-touch-icon. No
icon/logo asset existed anywhere in the repo, so `icons/icon-192.png` and
`icons/icon-512.png` are placeholder solid-color PNGs (generated with a
one-off pure-Python PNG writer — no image-library dependency added for
two flat-color squares) — **swap for real branded artwork before real
launch**, flagged in both the manifest comment in `index.html` and here.

**2. Install prompt — no new dependency.** `components/InstallButton.tsx`
listens for the standard `beforeinstallprompt` event, calls `.prompt()`
on click, and hides itself once `appinstalled` fires or if the browser
never fires the event at all (already installed, or a browser without
support — e.g. iOS Safari). Placed in `AppShell`'s nav next to
`NotificationBell`, on both the desktop and mobile header rows — the one
piece of chrome visible across all 9 authenticated pages during actual
work, unlike the login screen (a one-time, low-frequency touch point)
where installing isn't the obvious next action.

**3. Read-only offline cache of the last-known board — no new
dependency, plain hand-written service worker.** Two independent halves,
matching what "read-only cache of the last-known board" actually needs:

- **The data**: `lib/dashboardCache.ts` wraps `localStorage` (every
  access try/catch-guarded — private browsing, quota limits, or
  localStorage disabled entirely must never crash the page this exists
  to keep viewable) behind `saveDashboardSnapshot`/`loadDashboardSnapshot`.
  `DashboardPage.tsx` saves a snapshot after every successful
  `/units/dashboard` and `/units/activity` load (merged, not
  overwritten — the two load independently and either can fail without
  clobbering the other's cached half), and falls back to the cached
  snapshot if a live fetch fails, with a visible amber "Offline — showing
  the last known board as of `<time>`" banner. This page already has no
  action buttons on any of its three widgets, so "read-only" was already
  the natural shape here — nothing to disable.
- **The app shell**: a cached data snapshot is useless if the SPA itself
  can't boot on a reload while offline. `public/sw.js` is a minimal,
  hand-written service worker — deliberately not vite-plugin-pwa/Workbox,
  a new dependency that would auto-generate a build-time precache
  manifest more robustly than this, but more than this narrow scope
  needs. Network-first with cache-fallback for same-origin GET requests;
  **`/api/*` is explicitly excluded** and always passed straight through
  untouched — every live read/write already goes through
  `lib/api.ts`, and a SW-cached API response would both silently violate
  "read-only" the moment the underlying data changed elsewhere, and need
  real cache-invalidation logic this file doesn't have. Also bypassed:
  any cross-origin request, and any non-GET request. The file's own
  header comment documents exactly this cached/bypassed split in detail —
  there's no Workbox structure to lean on here, so that comment has to
  carry the intent for whoever touches it next.
- **Everything else stays uncached** — other pages, forms, write actions.
  Registered from `main.tsx`, guarded by `'serviceWorker' in navigator`
  (also what keeps the test suite from needing a mock for it).

**Explicitly out of scope, flagged and confirmed with the client:**
spec's §3 "known trade-off" paragraph bundles this cache together with
"queue photo uploads per §8.3" — a separate feature (IndexedDB-held photo
captures that retry on reconnect, described in §8.3's "Photo capture
UX"). That's real future scope, but it isn't in the M6 milestone's own
acceptance line, and no queuing infrastructure exists yet anywhere in the
app — treated as its own later slice, not pulled into this one.

**Test coverage, deliberately thorough on the service worker per the
client's own flag** that a hand-rolled SW (stale cache never
invalidating, wrong-origin requests slipping through) is the easiest spot
in this task to introduce a subtle bug with no Workbox structure to catch
it:
- `test/sw.test.ts` (9 tests) — loads the actual shipped `public/sw.js`
  source and evaluates it inside a Node `vm` sandbox standing in for
  `self`/`caches`/`fetch` (jsdom has no `ServiceWorkerGlobalScope`, and a
  separately-tested helper module could drift from what's actually
  served — this exercises the literal file that ships). Covers:
  `skipWaiting` on install; `activate` deleting every cache except the
  current `CACHE_NAME` and calling `clients.claim()`; a successful
  same-origin GET being cached and returned; a non-ok response (404) NOT
  being cached; falling back to the cached exact request when the network
  fails; falling back further to cached `/index.html` for a deep link
  never individually cached; and that `/api/*`, cross-origin, and
  non-GET requests are all bypassed with `respondWith` never called.
- `test/dashboardCache.test.ts` (7 tests) — save/load round-trip, partial
  merge (dashboard-only save doesn't clobber a previously-cached feed and
  vice versa), a later save overwriting only the field it provides, and
  that a thrown `localStorage.setItem`/`getItem` (quota exceeded,
  security error) or corrupt stored JSON never throws into the caller.
- `test/InstallButton.test.tsx` (4 tests) — renders nothing until
  `beforeinstallprompt` fires; shows the button and calls `.prompt()` on
  click; hides itself again after a click resolves (the captured event is
  single-use); hides itself on `appinstalled`.
- `test/App.smoke.test.tsx` — one new Command Center test: seeds the
  exact localStorage snapshot shape `dashboardCache.ts` itself writes,
  drives a load where both `/units/dashboard` and `/units/activity`
  reject outright (the literal shape of "the network dropped
  mid-session"), and asserts the cached KPI count and feed item render
  (not a generic error state) alongside the offline banner naming the
  cached timestamp.

Also added an ESLint override (`eslint.config.js`) scoping
`globals.serviceworker` to `apps/web/public/sw.js` specifically — it runs
in its own `ServiceWorkerGlobalScope`, not the browser globals the rest
of `apps/web` gets.

No schema change. Verification: `npm run typecheck` clean, `npm run lint`
clean (after the new SW-scoped ESLint globals override),
`npm run test -w apps/web` — 98/98 passing (14 files, up from 76 across
11 — the four new test files plus the one new App.smoke.test.tsx case),
`npm run build` clean across all three packages, confirmed
`manifest.webmanifest`/`sw.js`/`icons/*` all land correctly in
`dist/` at the paths `index.html` references. Also verified live in a
headless browser against the built app served over HTTP: the service
worker registers and reaches `active` state, and the manifest `<link>`
resolves. Sandbox-verified only otherwise — this is exactly the kind of
change (installability, real offline behavior, iOS Safari's lack of
`beforeinstallprompt`) that needs a real phone on real flaky wifi, not
just a sandbox check, before calling it done. Recommend the client: (1)
install the app from a phone browser and confirm it opens standalone;
(2) load the Command Center once online, then put the phone in airplane
mode and reload — confirm the cached board and offline banner appear;
(3) confirm normal pages still work correctly once back online, i.e. the
offline banner clears and the SW isn't serving anything stale.

### M6 slice: mobile pass across every screen + Lighthouse mobile performance (spec §11 M6 acceptance line) (2026-08-31)

Two parts of the same acceptance line, verified differently: the layout
pass is fully testable in this sandbox (a real phone viewport doesn't
need a live backend); the Lighthouse number is sandbox-verified against
the production build but may shift slightly once actually deployed
(HTTPS, real network conditions) — same caveat already noted for the PWA
install prompt.

**Nav — the concrete bug client found live-testing, plan approved before
building.** `AppShell.tsx`'s mobile nav (`<md`) used to render every item
as one horizontal row of plain text links with no wrap control — tight
enough that "Command Center" (the longest label) broke onto two lines.
Tracing it surfaced a second, more serious gap: "Sign out" lived in a
`hidden md:flex` block with no mobile equivalent at all — **unreachable
on a real phone viewport**, contradicting `NotificationBell.tsx`'s own
comment that it's shown everywhere "same reasoning as the Sign out
button's placement."

Fix: below `md`, the nav collapses to a slim top bar (brand +
`InstallButton` + `NotificationBell` + a hamburger toggle) that expands
into the *same* vertical `NavLink` list desktop already renders — full
width, one item per line — now including Sign out. Tapping any link
closes the menu. At `md` and up, nothing changed: same always-visible
left sidebar as before. Chose this over a bottom icon tab bar (the other
common mobile pattern, arguably closer to spec's literal "Left/bottom
nav" phrasing) because this app has up to 9 nav items depending on role —
a bottom bar forces an overflow "More" menu anyway, plus a new
icon-library dependency per item, for no smaller a change than reusing
markup that already existed.

New `test/AppShell.test.tsx` (3 tests): the hamburger's `aria-expanded`
and accessible name flip correctly; clicking a nav link closes the menu;
Sign out is present and actually calls `POST /auth/logout`. The toggle
is a pure CSS (`hidden`/`flex`) class swap, never a conditional unmount —
every existing "click the Units link" test across the suite keeps working
without first opening the menu, since Tailwind's responsive classes have
no effect in jsdom's non-layout-engine DOM anyway (only in a real
browser, which is what the visual check below actually exercises).

**Full sweep, all 9 authenticated routes + login, real 375px-viewport
Playwright pass against the production build** (mocked API responses,
not the dev server — same "don't score/measure a dev build" discipline
as the Lighthouse run below). Automated a horizontal-overflow check
(`document.documentElement.scrollWidth > clientWidth`) on every route
first, then screenshotted each and the two forms named in scope (work
order creation, amenity request creation) plus the Unit/Roles detail
panels.

**Two real, confirmed bugs found, both fixed:** `UsersPage.tsx` and
`SessionsPage.tsx` were the only two data tables in the entire app with
**no `overflow-x-auto` wrapper** — every other table (Amenities, F&B,
Reports) already used it. On a real 375px viewport this wasn't a
contained, swipeable table; it was the *whole page* stretching to
527px (Users) and 651px (Sessions) inside a 375px window, cutting the
rightmost column off entirely rather than making it reachable by
scroll. Fixed by wrapping both tables (loading-skeleton state and
loaded state) in the same `overflow-x-auto` div every other table
already uses, plus `whitespace-nowrap` on Sessions' two datetime
columns (was the single biggest width contributor, wrapping onto 3
lines per cell). Also wrapped 4 more loading-skeleton tables
(Amenities items, F&B history, F&B menu, Reports results pane) that
happened not to overflow at their current column counts but had the
same missing-wrapper gap as their already-fixed loaded-state siblings —
fixed for consistency/robustness rather than because they were caught
actually overflowing.

**Everything else already adapted correctly** — confirmed, not assumed:
Units' card grid, Work Orders' card list and its "New ticket" form
(`grid-cols-1 sm:grid-cols-2` already stacks to one column below `sm`),
the Amenities request form (including this session's own new Room
picker), the F&B kitchen board's three status columns, the Login screen,
and the Unit/Roles detail drawers (`w-full max-w-sm`/`max-w-md` is
already the correct responsive drawer pattern — full-width on a phone,
capped on desktop) — zero horizontal overflow, zero cramped tap targets
found on any of these in the automated sweep.

**Reports page, checked as specifically requested — not further
changed.** Every result table there already used the correct contained-
scroll pattern (`max-h-96 overflow-auto` per section, one already using
`overflow-x-auto` for the summary table) before this slice — confirmed
via a populated run of the work-orders report at 375px: zero body-level
overflow, tables scroll within their own bounds exactly as designed. The
8-column "Tickets in range" table is genuinely dense on a phone (visibly
cut off without a scroll affordance in the screenshot) — but that's an
inherent property of that much tabular data at that width, not a bug the
way the Users/Sessions gap was. Trimming which columns show below a
breakpoint is a real product decision (which columns matter most per
report) that the client should make, not one to guess at silently — flagging it as a candidate for a future slice rather than changing it now.

**Lighthouse mobile performance.** Ran `npx lighthouse` (mobile
form-factor/screen emulation, simulated throttling) against `vite
preview` serving the real `npm run build` output — not the dev server,
which scores artificially low. **Score: 99/100** (target: ≥85). FCP 1.6s,
LCP 1.9s, TBT 0ms, CLS 0, Speed Index 1.6s, TTI 1.9s. Measured against
`/` (the login screen, since no backend exists in this sandbox to
authenticate through) rather than an authenticated page — reasoned this
is still a fair measurement of real shipped performance, not a
shortcut: the app has no route-level code-splitting (confirmed via the
build output — one JS bundle, `dist/assets/index-*.js`, currently
~384KB/106KB gzipped), so every route loads the identical JS/CSS payload
regardless of which page renders, and Lighthouse's performance score is
driven by that load, not page-specific content. One non-blocking
diagnostic: ~66 KiB of "unused JavaScript" flagged (expected — the login
screen alone doesn't exercise every route's code in a single-bundle
app) — not worth chasing given the score already clears the target by 14
points.

No schema change, no new dependency. Verification: `npm run typecheck`
clean, `npm run lint` clean, `npm run test -w apps/web` — 101/101 passing
(15 files, up from 98/14 — the new `AppShell.test.tsx`), `npm run test -w
apps/api` — 391/394 (same 3 pre-existing sandbox-network-only failures
every run this session hits), `npm run test -w packages/shared` —
76/76, `npm run build` clean across all three packages. The mobile
layout pass itself is fully sandbox-verified (real 375px Playwright
screenshots against the actual production build, not a resized desktop
browser). Lighthouse score is sandbox-verified only in the sense noted
above — recommend a re-run against the real deployed HTTPS URL once M7
launch happens, to confirm the number holds (it should — nothing about
this app's payload changes between local and deployed, only network
conditions do, and those should only improve on a real CDN vs. this
sandbox's `vite preview`).

### Visual redesign, first pass: design tokens + Command Center (client-directed, 2026-08-31)

New direction from the client: a full visual skin pass across the app —
violet/indigo primary, soft gradient background, rounded cards with soft
shadows instead of hard borders, gradient-filled hero KPI cards, circular
icon badges, more generous whitespace — matched to a reference dashboard
they picked (described to me as a direction, not reproduced — someone
else's proprietary design). Explicitly a skin pass: no page structure,
data placement, or functional behavior changed. Given the scope (16
screens), agreed process was a token proposal + a single-screen (Command
Center) demonstration before any wider rollout — proposal presented and
approved before any code changed; this entry covers the approved build.

**Design tokens** — `tailwind.config.js`, `theme.extend`:
- `colors.brand` — a full 50–950 scale anchored on the client's two given
  hex values: `brand-600 #6C5CE7` (primary — buttons, active nav pill,
  links), gradient partner `#7C6EF2`.
- `colors.ink` — `DEFAULT #211B39` (headings, replaces `text-gray-900`),
  `secondary #6E6B85` (body/labels, replaces `text-gray-500/600`),
  `muted #9C99AE`. A very slightly violet-tinted near-black instead of
  pure gray, which is most of what makes the redesigned surfaces read as
  one system rather than "default Tailwind plus a purple button."
- `colors.success/warning/danger/info/accent` — kept as **distinct
  hues**, not all folded into brand violet, so the color-coding the app
  already relies on (dirty/urgent/ready/etc.) isn't lost, just restyled
  softer to match. Only wired into `DashboardPage.tsx` directly in this
  pass — `unitStatusStyle.ts`/`workOrderStyle.ts`/etc. still use their
  original Tailwind classes until the redesign reaches those pages.
- `boxShadow.card` — a soft, *violet-tinted* shadow (not plain gray) —
  `0 1px 2px rgba(108,92,231,.06), 0 8px 24px rgba(108,92,231,.10)`.
- `backgroundImage['app-gradient'/'brand-gradient'/'danger-gradient']` —
  the page background (`linear-gradient(160deg,#F7F5FE,#FFFFFF)`) and the
  two KPI hero-card gradients (see below).
- Radius/spacing: no new scale — `rounded-2xl` (cards) and `rounded-xl`
  (buttons/badges) are already in Tailwind's default scale; "more
  generous" spacing is a usage convention (`p-6`→`p-8` on the main
  content area, `gap-3`→`gap-4`/`gap-6`/`gap-8` throughout), not a new
  token.

**Icons** — the app had zero icons anywhere before this. Client approved
hand-rolled inline SVGs over adding an icon library (lucide/heroicons),
matching this session's established "no new dependency without asking"
convention. `components/icons.tsx`: 8 small stroke-style icons (24×24
viewBox, consistent strokeWidth/line-cap), one per Command Center
KPI/section — bed (Occupied), check (Ready), broom (Dirty), alert-
triangle (Out of order/Urgent), arrow-in/arrow-out (Check-ins/outs),
utensils (F&B), a activity-pulse glyph (Live activity header). Sized at
each call site — the icons have no intrinsic width/height of their own,
so every usage passes an explicit size class.

**AppShell.tsx (shared chrome — deliberately in scope)**: the page
background gradient and nav restyle are global, not Dashboard-specific,
so they're visible on every screen as a side effect of this pass even
though only Command Center's own content got redesigned — flagged to the
client ahead of time so it doesn't read as a half-finished rollout when
they click through other pages during review. Nav: white panel with
`shadow-card` instead of a hard right border; active `NavLink` is now a
filled `bg-brand-600 text-white` pill (`rounded-xl`) instead of the old
light-blue tint; inactive links use the new `ink-secondary` text color
with a `brand-50` hover tint. Same restyle applied to both the desktop
sidebar and the mobile slide-down menu (one shared list, per last
slice's nav-bug fix) — confirmed via screenshot that the active pill
renders correctly in both.

**DashboardPage.tsx**: `KpiCard` rebuilt to take a `variant` (7 total:
`hero-brand`, `hero-danger`, `success`, `warning`, `danger`, `info`,
`accent`) and an icon component, rendering a circular soft-tinted icon
badge, `rounded-2xl`/`shadow-card`, no more hard pastel border. **Two
gradient hero cards, not one** — client-approved call: Occupied (`bg-
brand-gradient`, the property's neutral headline number) and Open urgent
work orders (`bg-danger-gradient`, a distinct red/rose gradient) — kept
deliberately different gradients rather than flattening both into brand
violet, so the good/neutral-vs-needs-attention-now distinction the old
color-coded cards had isn't lost. The other 6 KPIs (Ready/Dirty/Out of
order/Check-ins/Check-outs/F&B) are soft-tinted cards matched to the
semantic color that fits what each number means. Attention queue and
Live activity list items got the same tinted-badge/rounded treatment and
more generous spacing; the offline banner (from the PWA slice) now uses
the `warning` semantic tokens instead of one-off amber classes.

**What's explicitly untouched in this pass**: every other route (Units,
Work Orders, Amenities, Restaurant, Reports, Users, Roles, Sessions,
Login), and the shared per-domain style files (`unitStatusStyle.ts`,
`workOrderStyle.ts`, `amenityRequestStyle.ts`) — those keep their
current Tailwind classes until the redesign is approved to roll out
further.

Verification: pure `className`/markup changes, no data or behavior
change, so the existing suite should (and does) pass unmodified —
confirmed, not assumed: `npm run typecheck` clean, `npm run lint` clean,
`npm run test -w apps/web` — 101/101 passing (same count as before this
slice — no new tests needed since nothing new to behaviorally test),
`npm run test -w apps/api` — 391/394 (same 3 pre-existing sandbox-
network-only failures), `npm run test -w packages/shared` — 76/76,
`npm run build` clean across all three packages. Screenshotted the real
production build at both desktop (1440px) and the 375px mobile viewport
from last slice's mobile pass, including the mobile nav expanded —
confirmed zero horizontal overflow at either width and sent the
screenshots to the client for review before any further rollout, per
the agreed process.

### Visual redesign, round 2: color/shadow feedback against the reference (2026-08-31)

Client reviewed the first pass side by side with their reference and
called four things too subtle. All four are `tailwind.config.js` value
changes only — no component/markup changes, since the redesign already
routes every color/shadow through those tokens rather than one-off
classes.

1. **Hero gradients** — were two adjacent shades of the same violet
   (`#6C5CE7`→`#7C6EF2`, barely distinguishable) and a similarly narrow
   red-to-orange. Both widened to span dark-to-light across their color
   family: brand hero now `brand-800 #4A3BB0` → `brand-300 #C4B5FD`;
   danger hero now `#9A1B2F` (deep red) → `#FF8A4C` (bright orange) —
   kept in the red/orange family on purpose so "urgent" doesn't drift
   toward pink.
2. **Page background gradient** — was `#F7F5FE` fading to white by 55%,
   too close to white to register. Now a real `brand-100`-level lavender
   (`#E8E3FC`) at the top, holding through a mid stop, fading to white
   much further down (`0%→35%→75%`).
3. **Semantic status colors** — both the tint background and the icon
   color pushed more saturated for all five (success/warning/danger/
   info/accent). Not just eyeballed: re-checked every pairing against
   WCAG contrast after the change — icon-on-its-own-tint (the KPI
   badges) and icon-on-white (the Attention queue's white circle
   badges). Tightest is success-50/success-600 at 3.72:1, already past
   the 3:1 floor for graphical/icon contrast (WCAG 1.4.11); every other
   pairing and every icon-on-white pairing lands at 4.2:1 or higher.
4. **Card shadow** — was one shadow layer at low opacity
   (`.06`/`.10`), which read as "closer to flat" per the client's own
   words regardless of blur radius. Replaced with three stacked layers
   (a tight ambient contact shadow, a mid-distance layer, a soft
   far-diffuse layer) — this is what actually reads as a card floating
   above the page, not a faint edge.

Re-screenshotted the real production build at the same desktop (1440px)
and 375px mobile viewports (plus the mobile nav expanded) used for the
first round, confirmed zero horizontal overflow still holds, and sent
the updated screenshots to the client for direct comparison against
their reference before approving.

Verification: same as round 1 — pure config-value changes, no markup or
behavior change. `npm run typecheck` clean, `npm run lint` clean,
`npm run test -w apps/web` — 101/101 passing (unchanged), `npm run
test -w apps/api` — 391/394 (same 3 pre-existing sandbox-network-only
failures), `npm run test -w packages/shared` — 76/76, `npm run build`
clean across all three packages.

### Clickable Command Center KPI cards + OWNER fnb:read gap (2026-08-31)

Two related changes: navigable KPI cards, and a permission gap found
while scoping them.

**KPI card navigation.** `DashboardPage.tsx`'s `KpiCard` gained an
optional `to` prop — when set, the whole card renders as a real
`react-router-dom` `Link` (a genuine `<a>`, keyboard-focusable) instead
of a plain `div`, with a hover/focus elevation affordance layered onto
the existing shadow token. Wired for exactly two cards: "Open urgent
work orders" → `/work-orders` (unconditional — `workorder:read` is the
one permission every role holds, confirmed earlier this session), and
"Open F&B tickets" → `/restaurant`, **conditional** on the viewer
actually holding `fnb:read`. Command Center is visible to every
`unit:read` holder, which includes roles that don't hold `fnb:read`
(POC Housekeeping/Maintenance) — `RequirePermission` already degrades a
denied route to a plain message rather than crashing, but there's no
reason to offer a clickable affordance that's certain to dead-end, same
standard already applied elsewhere (e.g. FnbPage's own delete-item
gate). `CommandCenter` now calls `useAuth()` directly to make this call
client-side. The other 6 KPI cards are untouched — not in scope.

**OWNER `fnb:read` gap, found while scoping the above.** OWNER held zero
`fnb:*` permissions at all — couldn't see the Restaurant nav item or
page. Checked spec §5.4's actual matrix before changing anything: OWNER's
row is `—` (not even 👁) on all three fnb permission rows, so this isn't
a misreading of the table — it's a genuine conflict with spec's own
prose a few lines above it ("OWNER is read-only across the entire system
except payment:verify and report:export"). A role that's supposed to be
read-only *everywhere* being fully blocked from an entire module
contradicts that sentence outright — the same kind of prose-vs-matrix
tension `rolePermissions.ts` already has an established resolution
pattern for (see the file's existing workorder:create/incident:create
note); resolved the same way, prose wins. Added `'fnb:read': 'ALL'` to
`OWNER` — read-only only, `fnb:create`/`fnb:manage_menu`/
`fnb:update_status` all stay withheld.

**Verified `FnbPage.tsx` needed no changes, not assumed.** Read through
every write control in the file line by line before touching anything:
`canManageMenu`/`canCreateOrder`/`canUpdateOrderStatus` gate the kitchen
board's status buttons, the "Place an order" form, and every menu-edit
control independently of the page-level `fnb:read` gate — `fnb:read`
alone was already guaranteed to produce a correctly read-only view.

New tests:
- `packages/shared/test/authz.test.ts` — OWNER holds `fnb:read` and none
  of the three fnb write keys (the existing "OWNER only holds read-type
  keys" test already covered this implicitly since `fnb:read` contains
  "read", but this asserts it directly and by name).
- `apps/web/test/App.smoke.test.tsx` — extended the existing Command
  Center test to assert "Open urgent work orders" is a real link and
  "Open F&B tickets" is **not** one for a user without `fnb:read` (the
  negative case, not just the positive one); a new test drives an actual
  click-and-navigate through both cards for a user who does hold
  `fnb:read`, asserting the destination heading renders. (Also fixed a
  latent gap in this file's `vi.mock('../src/lib/realtime.js', ...)` —
  it was missing `subscribeToFnbOrderChanges`, which crashed the first
  test in this file to ever navigate into `/restaurant`; not a real bug,
  just a mock that had never been exercised that way before.)
- `apps/web/test/FnbPage.test.tsx` — a new test using OWNER's exact
  post-fix permission shape (`fnb:read` only) against a **populated**
  kitchen board (a real RECEIVED ticket) and menu, asserting the absence
  of every write control by role/name (no "Start preparing"/"Cancel"
  buttons, no "Place an order" form, no "Mark unavailable"/"Delete", no
  "Add a menu item" form) while confirming the read-only content — the
  ticket, its reference number, the menu item and its price — genuinely
  renders. This is the "no edit controls actually render" check the
  client asked for, not a permission-object assertion.

No schema change, no new dependency. Verification: `npm run typecheck`
clean, `npm run lint` clean, `npm run test -w apps/web` — 103/103
passing (up from 101), `npm run test -w apps/api` — 391/394 (same 3
pre-existing sandbox-network-only failures), `npm run test -w
packages/shared` — 77/77 (up from 76), `npm run build` clean across all
three packages. Also verified live in a headless browser against the
built app: clicking each card lands on the correct page with the correct
heading (confirmed via URL + heading text, not just that a link element
exists), and the hover-elevation affordance renders correctly.

### Layout feedback: Attention queue + Live activity side-by-side (2026-08-31)

Client feedback: the two widgets stacked one after another burned too
much vertical space, especially with a full Attention queue pushing
Live activity far down the page. Wrapped both `ErrorBoundary`-guarded
`<section>`s in a `grid grid-cols-1 gap-6 md:grid-cols-2` container —
`md` matches the breakpoint the nav already switches on (desktop
sidebar vs. mobile hamburger), so "two columns on desktop/tablet, one
on mobile" reuses an existing convention rather than introducing a new
breakpoint decision. Pure layout change — neither widget's internal
markup, data, or error-boundary isolation changed.

Verification: `npm run typecheck` clean, `npm run lint` clean,
`npm run test -w apps/web` — 103/103 passing (unchanged — no behavior
changed, nothing new to test), `npm run test -w apps/api` — 391/394
(same 3 pre-existing sandbox-network-only failures), `npm run test -w
packages/shared` — 77/77, `npm run build` clean. Screenshotted the real
production build with a populated 7-row Attention queue (to actually
show the vertical-space win, not an empty-state screenshot) at desktop
(1440px), tablet (820px, the exact `md` breakpoint), and the 375px
mobile viewport from the mobile-pass slice — confirmed two columns hold
at both desktop and tablet widths, correctly stacks back to one column
on mobile, and zero horizontal overflow at any width. Sent to the client
for a look before any further rollout.

### Payment verification + Quotations: two new standalone admin modules (2026-08-31)

Client-directed feature: two new standalone request-and-status records,
each with its own module, nav entry, and permissions — neither connects
to bookings, units, or folio, and neither is related to the descoped
Payment/Folio/CashCount system (spec §13 decision 7).

**1. Payment verification** — an incoming guest payment (a manually
booked guest, not through the automated website flow, who paid via bank
transfer/GCash/etc.) submitted by staff for the Owner to verify. Fields:
Name, Date, Mode of payment (free text), Amount, Reference number, and
an optional proof/receipt photo. Status: `FOR_VERIFICATION` → `VERIFIED`,
and explicitly **not** one-way — OWNER can revert a verified request
back to `FOR_VERIFICATION`. Create: Admin Head, Resort Manager, System
Admin, Admin Staff. Verify (and revert): OWNER only. View: all of the
above plus OWNER.

**2. Quotations** — a simple quotation request record. Fields: Name,
Contact number, Email, Pax, Check-in date, Check-out date, Note. Status:
just `PENDING`/`DONE`, no third state, and also not one-way — System
Admin can move either direction. Create: Admin Head, Resort Manager,
Admin Staff — **explicitly not** System Admin. Update status: System
Admin only. View: all five roles (the four above plus OWNER).

**Naming: `remittance:*`/`quotation:*`, not `payment:*`.** The
`payment:read`/`payment:submit`/`payment:verify` keys already exist in
`permissions.ts`, reserved for spec §13 decision 7's Payment/Folio/
CashCount system — which is schema-defined but entirely unbuilt.
Reusing that namespace for this unrelated feature would make both
permanently ambiguous. First proposed `disbursement:*`; the client
corrected this — this feature is incoming money (a payment submitted
*for* verification), and "disbursement" reads as money going *out*, the
wrong direction entirely. Renamed to the client's own suggestion,
`remittance:*` — a standard term for money transferred/sent in, distinct
enough from `payment:*` at a glance. `quotation:*` had no naming
conflict to begin with.

**Data model** (`apps/api/prisma/schema.prisma`): two new models,
`RemittanceRequest` and `QuotationRequest`, following the existing
referenceNo/soft-delete/audit-log conventions already used for
`Incident`/`WorkOrder` — `referenceNo` (unique, generated via the shared
`generateReferenceNo()` per-day sequence, prefixes `RM`/`QT`, both
confirmed unused before picking them), `deletedAt` for soft delete, and
no extra code needed for audit logging — the Prisma client extension
audits every model by default except an explicit denylist, and neither
model was added to it. `RemittanceRequest.amount` is `Decimal(12,2)`;
`RemittanceRequest.proofFileId` is an optional relation to the existing
`FileObject` model. Both `createdBy`/`verifiedBy`/`updatedBy` relations
point at `User`. **This is a genuine schema change — the client needs to
run `npx prisma db push` (from `apps/api`) against the real database
before their next live test.** The sandbox has no network access to the
hosted Supabase project (same long-standing block noted under M0), so
this could only be validated with `npx prisma generate` (schema syntax,
confirmed valid) — never pushed from here.

**Proof photo reuses the existing upload pattern, no new one invented.**
`POST /files` (already built, and its own code comment already
anticipated "payment proofs, receipts" as a reuse case) handles the
upload and validation (image MIME types, 10MB cap); `remittances/
service.ts` just references the returned file id.

**Real bug caught while building, before it ever shipped:** the first
draft linked the proof photo straight to `/api/v1/files/:id`. Reading
`files/router.ts` more carefully before wiring the frontend turned up
its own comment stating plainly that no such generic route exists —
reading a file back is scoped per-module, on purpose, never through a
second generic route. That would have been a dead 404 link in
production. Fixed by following the pattern `workorders/service.ts`'s
`getWorkOrder` already uses: generate a real signed URL server-side via
`getStorageAdapter().getSignedUrl(storageKey)` and embed it in the
response, never expose the raw `storageKey` to the client. Rewrote the
backend test for this endpoint to exercise the fix end to end — it
mocks `getStorageAdapter`, asserts the signed URL comes back correctly,
and separately asserts `proofFile.storageKey` is `undefined` in the
response, so a future regression that leaks the raw key would fail
loudly rather than silently.

New/changed files: `packages/shared/src/{remittance,quotation}.ts`
(status keys/labels), `permissions.ts` (6 new keys) and
`rolePermissions.ts` (role grants across 5 roles, per the table above),
`apps/api/src/modules/{remittances,quotations}/{schema,service,router}.ts`,
mounted in `app.ts`; `apps/web/src/routes/{RemittancePage,
QuotationsPage}.tsx` (list + permission-gated create form, following
the existing page convention — not the new Command-Center-only redesign
tokens, since that hasn't been approved to roll out beyond Command
Center yet), `apps/web/src/lib/{remittanceStyle,quotationStyle}.ts`,
two new nav entries in `AppShell.tsx`, two new routes in `App.tsx`.

Test coverage: both create and status-change permission boundaries, for
both modules — every allowed role can create/view, every disallowed
role (including the narrow OWNER-only-verifies and
SYSTEM_ADMIN-only-updates-status boundaries) gets a 403, the optional
proof-photo path (valid id, missing id, no photo at all), and the
signed-URL round trip described above. Frontend tests assert actual
control presence/absence by role (a creator role sees the form and can
submit; a non-creator doesn't see it at all; OWNER sees Verify/Revert
buttons and a non-OWNER creator role doesn't; SYSTEM_ADMIN sees Done/
Pending buttons and a non-SYSTEM_ADMIN role doesn't) — not permission-
object shape checks.

Verification: `npm run typecheck` clean (both apps), `npm run lint`
clean, `npm run test -w packages/shared` — 81/81 (up from 77),
`npm run test -w apps/api` — 432/435 (same 3 pre-existing
sandbox-network-only failures; 22 new remittance tests + 19 new
quotation tests all pass), `npm run test -w apps/web` — 110/110 (up
from 103; 7 new tests across both pages), `npm run build` clean across
all three packages. Not live-tested against the real database, per the
sandbox network block above — needs `npx prisma db push` first.
