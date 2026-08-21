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
  cookies, `POST /auth/login|refresh|logout`, `GET /auth/me`. Password-
  only for now — TOTP 2FA, login rate limiting/lockout, and the session-
  list/revocation UI are a separate task, not deferred out of M1.
- Refresh tokens rotate on every use, with reuse detection: `Session`
  gained a `previousRefreshTokenHash` column so a replayed pre-rotation
  token can be told apart from a plain invalid one — replay revokes that
  session immediately and writes a distinct `REFRESH_TOKEN_REUSE_DETECTED`
  audit entry, while still keeping one `Session` row per logged-in device
  (needed for the "sign out all other devices" UX in spec §3.1.1).
- 29 new tests across `packages/shared` and `apps/api` (permission
  matrix invariants; password/JWT unit tests; service-level
  login/refresh/logout/getMe against a mocked Prisma client; router-level
  tests via supertest confirming real httpOnly cookies and the spec
  §4.8 error shape). Full lint/typecheck/build clean.

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

### Schema change needs syncing to the hosted project

`Session.previousRefreshTokenHash` (nullable `String?`) was added for
refresh-token rotation. This session's sandbox can't reach the hosted
Supabase project to push it (same network block noted under M0). Run
`npx prisma db push` (from `apps/api`) against the real database before
relying on login/refresh working end-to-end.

See `spec.md` §11 for the full M1 acceptance criteria — not all met yet.
