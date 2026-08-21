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

## M1 — Auth, RBAC & hardening — in progress

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
  fast per-request check (5 failures / 15 min, per account or IP) returns
  `429` before password verification even runs; a slower check (10
  failures / hour — spec's own M1 acceptance number) locks the account
  with a duration that escalates on repeat lockouts (30 min, then 2h,
  then 24h), derived by counting past `ACCOUNT_LOCKED` audit entries
  rather than a separate counter column.
- TOTP 2FA for OWNER/SYSTEM_ADMIN (spec §3.1.1), via `otpauth`. First
  login for an unenrolled account generates and persists a secret and
  returns `{ totpSetupRequired: true, provisioningUri }` — **no
  session is issued** until a subsequent login call includes a valid
  code, so "an owner account cannot complete login without a TOTP code"
  holds even on first-ever login, not just after enrollment. A missing
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

### Schema changes need syncing to the hosted project

`Session.previousRefreshTokenHash` and `User.totpSecret` (both nullable
`String?`) were added for refresh-token rotation and TOTP enrollment.
This session's sandbox can't reach the hosted Supabase project to push
them (same network block noted under M0). Run `npx prisma db push`
(from `apps/api`) against the real database before relying on
login/refresh/TOTP working end-to-end.

See `spec.md` §11 for the full M1 acceptance criteria — not all met yet.
