# Lucky Waku-Waku Resort Command Center

See `spec.md` at the repo root for the full product/technical spec. This
README tracks what actually works, milestone by milestone, and is updated
at the end of each one per spec §12 rule 11.

## M0 — Scaffold

### What works

- npm workspaces monorepo: `apps/api` (Express + TypeScript), `apps/web`
  (Vite + React 19 + Tailwind), `packages/shared`.
- Full Prisma schema for every model in spec §6 (including the Phase 2
  tables, modeled now per spec §11's backlog note). `prisma generate`
  succeeds.
- `RealtimeAdapter` and `StorageAdapter` interfaces (`apps/api/src/adapters/`)
  with Supabase-only implementations, matching spec §3.1 — no Socket.IO or
  local-disk implementation exists, by design.
- `GET /api/v1/health` — returns adapter resolution and region, no network
  or DB calls.
- `apps/web` fetches `/api/v1/health` on load and renders it (scaffold
  only; the real Command Center is M2+).
- `vercel.json` is written to spec but **not deployed** — the first
  deploy is M2 (a preview deploy, not launch — see spec §3.1/§11).
- ESLint (flat config, Node/browser globals split correctly) and Prettier
  are wired and clean across the whole repo.
- `npm run typecheck`, `npm run lint`, `npm run build`, and `npm test` all
  pass. `npm run dev` boots both apps together and the web dev server
  proxies `/api` through to the API on port 3001.
- `scripts/check-serverless-safety.sh` greps `apps/api/src` for
  `setInterval` (hard fail) and `setTimeout` (flagged for manual review) —
  currently clean.

### Development stack: hosted Supabase, no Docker

Per spec §3.1 (updated), development runs against a real hosted Supabase
project instead of a local CLI stack — no Docker required. The client
supplies connection strings and keys; they are read from environment
variables only and never committed (`.env` is gitignored; only
`.env.example` is tracked — see `apps/api/.env.example`).

```bash
npm install
cp apps/api/.env.example apps/api/.env   # fill in from the client-provided credentials
npm run dev                               # api on :3001, web on :5173
```

### Storage/Realtime adapter round-trips

`apps/api/test/adapters/{storage,realtime}.roundtrip.test.ts` exercise the
Supabase adapters for real. They skip cleanly (`describe.skipIf`) when
`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` aren't set, and run for real
against the hosted project once they are:

```bash
npm run test -w apps/api
```

**Status as of this commit: not yet run.** This was previously blocked on
having no local Supabase stack to test against (no Docker daemon in that
sandbox). Development now targets a hosted project instead, so this is
unblocked as soon as the client-provided credentials are set in
`apps/api/.env` — pending that, then re-run and update this line.

### Known gaps carried into M1 (not blockers, just not built yet)

- `Booking.status`, `Notification.type`, `Incident.severity`, and
  `Expense.status` are `String` in the Prisma schema, not enums — spec.md
  didn't enumerate their values. `Booking.status` needs a real state
  machine before M4; the others are Phase 2.
- This sandbox runs Node 22, not the Node 24 the spec pins (`.nvmrc`,
  `package.json#engines`). `npm install` warns (`EBADENGINE`) but every
  command still ran correctly. Confirm on Node 24 before relying on this.

## M1 and beyond

Not started. See `spec.md` §11 for the milestone plan.
