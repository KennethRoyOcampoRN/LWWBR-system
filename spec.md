# spec.md — Lucky Waku-Waku Resort Command Center (MVP)
> **How to use this file:** place it at the repo root, open Claude Code in the repo, and start with:
> `Read spec.md end to end. Do not write code yet. Produce a build plan with milestones and a list of every assumption you had to make. Wait for my approval.`
> Then work milestone by milestone (`Implement M1 only. Stop when the acceptance criteria for M1 pass.`).
---
## 1. Product summary
A web-based **operations command center** for Lucky Waku-Waku Beach Resort (Lian, Batangas). One shared source of truth for room/cottage status, work orders, guest requests, amenity lending, and restaurant orders — with a role-scoped dashboard for every department and exportable reports for management.
**Property scope:** 13 guest rooms, 3 day-tour cottages, shared facilities (pool, beach frontage, open fields, comfort rooms, function areas), an in-house restaurant, and lendable amenities (game consoles, videoke, board games, outdoor equipment).
**Primary users:** ~15–30 staff across 12 roles, most of them on **Android phones while walking the property**, on intermittent mobile data.
**Core promise:** any staff member can see, in under 3 seconds, what is assigned to them right now — and any manager can see, in under 3 seconds, what is blocking the property right now.
**Why this is a hosted web app and not an on-site tool:** the owner and system admin need to monitor operations while away from the property, including from overseas. Remote visibility is a primary requirement, not a convenience. Every design choice that trades remote access for on-site simplicity is the wrong trade here.
---
## 2. Non-goals (do NOT build in MVP)
- Public-facing booking engine, availability calendar sync, or OTA/channel manager integration.
- Payment gateway / card processing. Payments are recorded and **verified manually** from uploaded proof.
- Full accounting, payroll computation, BIR/SSS/PhilHealth/Pag-IBIG filing. MVP only produces **exports** that a human uses for these.
- POS with printers, KDS hardware, or table management. Restaurant module is order-routing only.
- Native mobile apps. Build a responsive, installable PWA instead.
- Guest-facing login. Guests never touch this system in MVP.
- Chat/messaging between staff (they use Messenger). The system produces **notifications**, not conversations.
---
## 3. Tech stack (fixed — do not substitute without asking)
| Layer | Choice |
|---|---|
| Monorepo | npm workspaces: `apps/web`, `apps/api`, `packages/shared` |
| Frontend | React 19 + TypeScript + Vite, Tailwind CSS, shadcn/ui, TanStack Query, React Router, `react-hook-form` + zod |
| Backend | **Node 24 (Active LTS)** + Express + TypeScript. Not Node 20 — it reached EOL on 30 April 2026 and receives no further security patches. Pin with `.nvmrc` and `engines` in `package.json`, and set the Netlify Functions Node version to match. |
| ORM/DB | Prisma + **PostgreSQL 16** — Supabase-hosted or self-hosted (see §3.1) |
| Realtime | `RealtimeAdapter` interface with two implementations: Socket.IO (self-host) and Supabase Realtime (cloud). App code emits domain events; it never imports either library directly. |
| Auth | **Application-level JWT**, not Supabase Auth: access token (15 min) + refresh token (7 days), both in `httpOnly` `SameSite=Lax` cookies; `argon2` password hashing |
| Validation | zod schemas defined once in `packages/shared`, imported by both api and web |
| File uploads | `StorageAdapter` interface with two implementations: local disk `./uploads` (self-host) and Supabase Storage (cloud). Served through an authenticated `/files/:id` route in both cases — never expose a public bucket URL for payment proofs or damage photos. |
| Testing | Vitest + Supertest (API), Vitest + Testing Library (web smoke tests only) |
| Tooling | ESLint, Prettier, `tsx` for dev, `concurrently` for `npm run dev` |
### 3.0 Why not Supabase Auth or RLS
Authorization here is a role→permission matrix with per-department scoping (§5), and it must stay editable at runtime by the system admin. Encoding that in Postgres RLS policies means every permission change becomes a migration, and the whole policy set would have to be rewritten if the resort moves between cloud and on-prem. Keep **all** authorization in the Express layer via `requirePermission`, and treat Postgres as a plain database. Supabase is used for hosting, storage, and realtime transport only.
### 3.1 Deployment target — cloud, decided (but built locally first)
**Build for Netlify + Supabase. This is settled, not a menu.** The owner and system admin must be able to monitor the resort from anywhere including overseas, which makes a hosted deployment the requirement rather than an option.
**Development uses a hosted Supabase project, not a local stack.** A Supabase project in `ap-northeast-1` (Tokyo) serves as the development database, storage, and realtime backend from M0 onward. There is **no Docker requirement and no `supabase start`** — an earlier draft of this spec called for the Supabase CLI local stack; that approach is withdrawn.
Reasons, so this isn't relitigated:
- The build agent runs in a sandbox without a Docker daemon. A local-stack requirement makes every adapter test unrunnable by the agent and turns the developer into a manual relay for error messages.
- The same Supabase project is used for development and, after upgrade to Pro, for production. No migration, no region change, no "worked locally, broke in production" gap.
- Free tier is sufficient for development. It pauses after 7 days idle and wakes with a click — irrelevant while building, which is exactly why the launch checklist requires the Pro upgrade before staff depend on it.
**On the region: `ap-northeast-1`, not `ap-southeast-1`.** An earlier draft of this spec called for the Supabase project to sit in `ap-southeast-1` (Singapore) as the geographically nearest region to the property in Lian, Batangas. The project that was actually created lives in `ap-northeast-1` (Tokyo) instead. Region is fixed at creation and changing it later means migrating the whole database, so the spec now matches the real project rather than the other way around. This is a real, accepted trade-off, not an oversight: Tokyo is farther from Batangas than Singapore would have been, so **at M7 the Netlify Functions region must be moved to co-locate with Tokyo (`ap-northeast-1`), not Singapore** — see §3.1 Production target and §11.1 below, both updated to match.
Development environment:
- `DATABASE_URL` — Supabase **transaction pooler** URI (port 6543) with `?pgbouncer=true&connection_limit=1`.
- `DIRECT_URL` — Supabase **direct** URI (port 5432), used by Prisma migrations only.
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` — from Settings → API.
- All of these live in `apps/api/.env`, which **must** be gitignored. The `service_role` key bypasses every permission check in this system; treat it as equivalent to the database password. It is never committed, never logged, and never sent to the browser bundle.
**Netlify deployment still waits.** Nothing deploys until the Netlify work in §11.1. `netlify.toml` and the function wrapper are written to spec during the build so the launch step is configuration rather than construction, but no site is created and no cloud spend occurs before then.
**Production target (M7):**
- SPA and API both deploy to Netlify. The Express app is wrapped with `serverless-http` and exposed as a single Netlify Function at `netlify/functions/api.ts`; `netlify.toml` redirects `/api/*` to it.
- **Serverless holds no long-lived connections, so Socket.IO cannot run there.** Use **Supabase Realtime** (Postgres change streams over a WebSocket that Supabase holds, not your function).
- **Prisma on serverless needs pooling.** Use Supabase's pooler on port `6543` with `?pgbouncer=true&connection_limit=1` as `DATABASE_URL`, and the direct `5432` connection as `DIRECT_URL` for migrations only. Skip this and you will exhaust connections within a day of real use.
- **Region — read this carefully, it is the one real weakness of the Netlify route.** Netlify Functions default to US East (Ohio), and changing the functions region is a **paid-plan feature**. Supabase is in `ap-northeast-1` (Tokyo) — see the note above on why this is Tokyo rather than the originally planned Singapore — and the region is unchangeable after project creation.
  - During development on the Netlify free tier, functions run in Ohio while the database sits in Tokyo. Every query crosses the Pacific. **This is accepted for development** — dev latency is irrelevant — but it is not acceptable for production.
  - **At launch (§11.1), the functions region must be moved to `ap-northeast-1`**, which requires a paid Netlify plan. Do not launch on the free tier with the function in Ohio: with several queries per request, the round trips compound and every room-status tap on the property pays for it.
  - The SPA itself is served from Netlify's CDN edge and is fast everywhere regardless. This is purely an API-to-database problem.
- Backups: Supabase automated daily backups on Pro, plus a scheduled `pg_dump` to separate off-site storage. Do not rely on a single vendor's backups for the property's financial records.
- **Why Netlify rather than Vercel.** Netlify's free tier permits commercial use; Vercel's Hobby tier does not, and Vercel defines commercial use broadly enough to cover a paid developer building the project. Netlify therefore allows honest free development from day one. The trade is the region limitation above.
- **Free during development, paid at launch.** Netlify free for all of M0–M6.5. At launch: a paid Netlify plan (for the functions region) and Supabase Pro (~$25/mo — the free tier auto-pauses a project after 7 days idle, fatal for a system that must answer at 2am on a quiet Tuesday). Turn on spend caps at setup.
**Still keep the adapters.** `StorageAdapter` and `RealtimeAdapter` interfaces remain, but MVP ships only the Supabase implementations. The interfaces cost almost nothing and keep a future on-prem or self-hosted move from becoming a rewrite. Do **not** build the Socket.IO or local-disk implementations now.
**Known trade-off, document it in the README:** when the resort's internet drops, the on-site staff lose the system. This is acceptable because (a) staff are on phones with mobile data, so resort wifi failing is not the same as internet failing, and (b) the alternative — an on-prem box — fails the primary remote-access requirement the moment the same connection drops, while additionally being invisible off-site and putting backups and uptime on resort staff. Mitigate with the PWA: cache the last-known board read-only so a staff member with no signal still sees their task list, and queue photo uploads per §8.3.
**Write serverless-safe code from day one, even though local dev is a long-lived process.** This is the main trap in building locally and deploying to Netlify later, and it is invisible until launch day:
- **No module-level mutable state.** No in-memory caches, counters, sessions, rate-limit tallies, or connection registries. Every function invocation may be a cold, isolated process. Rate limiting and lockout state (§3.1.1) live in Postgres, not in a `Map`.
- **No `setInterval` / `setTimeout` background jobs.** The amenity-overdue sweep (§7.4) and the owner digest (§8.3) must be plain authenticated HTTP endpoints — `POST /api/v1/jobs/amenity-overdue`, `POST /api/v1/jobs/owner-digest` — protected by a shared secret header. Locally, trigger them with a script or by hand. In production, **Netlify Scheduled Functions** call them on a schedule. A `setInterval` in a serverless function simply never fires.
- **No writing to the local filesystem** except OS temp during a single request. All uploads go through `StorageAdapter`.
- **Assume every request is a cold start.** Keep the Prisma client a module singleton guarded for hot-reload, and do not do expensive work at import time.
Keep all Prisma queries portable — no raw SQL, no Postgres-only column types — so the datasource stays swappable.
### 3.1.1 Internet-exposed means security is not optional
This system holds guest names, contact details, payment proofs, and revenue figures, and it is reachable from anywhere. MVP must include:
- **Rate limiting on `/auth/login`** (per IP and per account) and progressive lockout after repeated failures.
- **Two-factor authentication (TOTP) required for `OWNER` and `SYSTEM_ADMIN`**, optional for everyone else. These are the accounts that can see financials and change permissions, and they are the ones logging in from unfamiliar overseas networks.
- **Session list and remote revocation** in user settings — "sign out all other devices". Staff phones get lost; a resort phone in a tricycle is a data breach.
- **No public storage buckets.** Payment proofs and guest waivers are served only through the authenticated `/files/:id` route with a permission check, never a public Supabase Storage URL.
- **Force HTTPS, HSTS, secure cookie flags.** Reject non-TLS.
- **Login notification** to the user on a new device or country.
- Audit log already captures `ip` and `userAgent` (§4.4) — surface a "recent sign-ins" view for `SYSTEM_ADMIN`.
### 3.2 Locale
- Timezone `Asia/Manila` everywhere. **Store all timestamps in UTC, render in Asia/Manila.** Never store naive local time.
- **Never use the viewer's device timezone.** The owner may be opening this from another country, and a report bucketed by their local midnight would silently show the wrong day's revenue. All "today", "this week", and report date boundaries resolve against Asia/Manila regardless of where the browser sits. Label ambiguous times in the UI as `2:30 PM PHT` so an overseas viewer knows what they're reading.
- Currency PHP, formatted `₱1,234.50`.
- UI copy in English; keep all user-visible strings in a single `packages/shared/src/strings.ts` so a Taglish pass is possible later.
---
## 4. Non-functional requirements
1. **Mobile-first.** Design every screen at 390px width first. Primary actions must be reachable one-thumbed. Tap targets ≥44px.
2. **Low bandwidth.** Initial JS bundle < 300KB gzipped. Route-level code splitting. No auto-playing media. Images uploaded from the client must be resized to max 1600px / ~70% JPEG quality **before** upload.
3. **Realtime but resilient.** Socket.IO pushes updates; TanStack Query still polls every 60s as a fallback and refetches on window focus. A dropped socket must never leave a stale board with no recovery path — show a subtle "reconnecting" indicator.
4. **Audit everything.** Every create/update/delete on a domain entity writes an `AuditLog` row (actor, action, entity, entityId, before, after, ip, userAgent, timestamp). This is a hard requirement, not optional — implement it as Prisma middleware or a shared service wrapper, not by hand at each call site.
5. **Soft delete.** Domain records use `deletedAt`; nothing is hard-deleted from the UI.
6. **Optimistic concurrency** on status transitions: include `version` (int) on `Unit`, `WorkOrder`, and `FnbOrder`; reject mismatched writes with `409` and a "someone else updated this" toast. Two housekeepers tapping the same room at once is the normal case here, not the edge case.
7. **Accessibility.** WCAG AA contrast minimum. Status must never be conveyed by colour alone — always pair with a label or icon.
8. **Errors.** All API errors return `{ error: { code, message, details? } }`. Never leak stack traces in production.
---
## 5. Roles & permissions
### 5.1 Design rule
**Do not hardcode role names in business logic.** Users have many `Role`s; each `Role` has many `Permission`s; a user's effective permission set is the **union** of their roles'. All authorization checks are permission checks (`requirePermission('workorder:assign')`). Roles and their permission sets are seeded but editable by `SYSTEM_ADMIN` through the UI — this is an explicit requirement from the client ("each user is assigned role or roles by system admin").
### 5.2 Seeded roles
Roles are **positions, not people.** No individual's name appears anywhere in the schema, seed, or UI copy. Who holds a role is decided at runtime by `SYSTEM_ADMIN` assigning it to a `User`, and can change at any time without a code change or migration.
| Key | Label | Scope / notes |
|---|---|---|
| `SYSTEM_ADMIN` | Marketing Manager / System Admin | Super admin, system configurator |
| `OWNER` | Owner | Global **read-only** + payment verification |
| `RESORT_MANAGER` | Resort Manager / Operations Head | Supervises all POCs and shift staff |
| `OPS_SAFETY_SUPERVISOR` | Operations & Safety Supervisor | On-duty performance, safety, purchasing, COH |
| `ADMIN_HEAD` | Admin Head | Oversees admin staff and daily report consolidation |
| `ADMIN_STAFF` | Admin Staff | Chat support + receptionist |
| `CASHIER` | Cashier | Manual booking entry, payment collection, folio settlement, COH |
| `POC_HOUSEKEEPING` | POC Housekeeping | Department head for housekeeping |
| `HOUSEKEEPING_STAFF` | Room Attendant | Reports to POC Housekeeping |
| `POC_MAINTENANCE` | POC Maintenance & Facilities | Department head for maintenance, grounds, lifeguards |
| `MAINTENANCE_STAFF` | Maintenance Technician | Reports to POC Maintenance |
| `RESORT_STAFF` | Resort Staff | Groundskeeper / Lifeguard / Security |
| `RESTAURANT_MANAGER` | Restaurant Manager | Department head for F&B |
| `RESTAURANT_STAFF` | Restaurant Staff | Kitchen / service |
### 5.3 Permission keys
Format `resource:action`. Seed at minimum:
```
user:read  user:manage  role:manage
unit:read  unit:update_status  unit:manage  unit:block  unittype:manage
booking:read  booking:create  booking:update  booking:checkin  booking:checkout
payment:read  payment:submit  payment:verify
folio:read  folio:charge  folio:settle  folio:void
workorder:read  workorder:read_all  workorder:create  workorder:assign
workorder:update_status  workorder:verify  workorder:close
amenity:read  amenity:request  amenity:approve  amenity:issue  amenity:return  amenity:manage
fnb:read  fnb:create  fnb:update_status  fnb:manage_menu
inventory:read  inventory:request  inventory:adjust
shift:read  shift:manage  restday:request  restday:approve
cash:read  cash:record  cash:verify
incident:create  incident:read  inspection:submit  inspection:read
report:view  report:export
audit:read  system:configure
```
### 5.4 Permission matrix (seed values)
Legend: ✅ granted · 👁 read-only variant · — none
| Permission group | SYS_ADMIN | OWNER | RESORT_MGR | OPS_SAFETY | ADMIN_HEAD | ADMIN_STAFF | CASHIER | POC_HK | HK_STAFF | POC_MAINT | MAINT_STAFF | RESORT_STAFF | REST_MGR | REST_STAFF |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| user/role manage | ✅ | — | 👁 | — | — | — | — | — | — | — | — | — | — | — |
| unittype manage | ✅ | — | ✅ | — | — | — | — | — | — | — | — | — | — | — |
| unit manage (add/rename/capacity) | ✅ | — | ✅ | — | — | — | — | — | — | — | — | — | — | — |
| unit read | ✅ | 👁 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 👁 | 👁 | — |
| unit update_status | ✅ | — | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ | ✅ | — | — | — |
| unit block / OOO | ✅ | — | ✅ | ✅ | — | — | — | ✅ | — | ✅ | — | — | — | — |
| booking read | ✅ | 👁 | ✅ | 👁 | ✅ | ✅ | ✅ | 👁 | — | — | — | — | 👁 | — |
| booking create/update | ✅ | — | ✅ | — | ✅ | ✅ | ✅ | — | — | — | — | — | — | — |
| booking checkin/out | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | — | — | — | — | — |
| payment submit | ✅ | — | ✅ | — | ✅ | ✅ | ✅ | — | — | — | — | — | — | — |
| payment verify | ✅ | ✅ | ✅ | — | ✅ | — | — | — | — | — | — | — | — | — |
| folio read | ✅ | 👁 | ✅ | 👁 | ✅ | ✅ | ✅ | — | — | — | — | — | 👁 | — |
| folio charge | ✅ | — | ✅ | — | ✅ | ✅ | ✅ | — | — | — | — | — | ✅ | ✅ |
| folio settle | ✅ | — | ✅ | — | ✅ | — | ✅ | — | — | — | — | — | — | — |
| folio void | ✅ | — | ✅ | ✅ | — | — | — | — | — | — | — | — | — | — |
| workorder create | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| workorder read_all | ✅ | 👁 | ✅ | ✅ | ✅ | — | — | dept | — | dept | — | — | dept | — |
| workorder assign | ✅ | — | ✅ | ✅ | — | — | — | ✅ | — | ✅ | — | — | ✅ | — |
| workorder update_status | ✅ | — | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| workorder verify/close | ✅ | — | ✅ | ✅ | — | — | — | ✅ | — | ✅ | — | — | ✅ | — |
| amenity request | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | — | ✅ | — | — |
| amenity issue/return | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | ✅ | — | — |
| fnb create order | ✅ | — | ✅ | — | ✅ | ✅ | ✅ | — | — | — | — | — | ✅ | ✅ |
| fnb update_status | ✅ | — | 👁 | — | 👁 | 👁 | 👁 | — | — | — | — | — | ✅ | ✅ |
| fnb manage_menu | ✅ | — | ✅ | — | — | — | — | — | — | — | — | — | ✅ | — |
| inventory request | ✅ | — | ✅ | ✅ | ✅ | — | — | ✅ | — | ✅ | — | — | ✅ | ✅ |
| inventory adjust | ✅ | — | ✅ | ✅ | — | — | — | ✅ | — | ✅ | — | — | ✅ | — |
| cash record | ✅ | — | ✅ | ✅ | ✅ | — | ✅ | — | — | — | — | — | ✅ | — |
| cash verify | ✅ | 👁 | ✅ | ✅ | — | — | — | — | — | — | — | — | — | — |
| shift manage | ✅ | 👁 | ✅ | ✅ | ✅ | — | — | ✅ | — | ✅ | — | — | ✅ | — |
| restday approve | ✅ | — | ✅ | ✅ | — | — | — | — | — | — | — | — | — | — |
| incident create | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| report view | ✅ | ✅ | ✅ | ✅ | ✅ | — | 👁 | dept | — | dept | — | — | dept | — |
| report export | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | — | — | — | — | — | ✅ | — |
| audit read | ✅ | 👁 | ✅ | — | — | — | — | — | — | — | — | — | — | — |
`dept` = scoped to own department only. Implement as a `scope` field on the role-permission join (`ALL` \| `DEPARTMENT` \| `SELF`) rather than a separate permission key.
**OWNER is read-only across the entire system except `payment:verify` and `report:export`.** Enforce this at the API layer, not just by hiding buttons.
**OWNER sees full peso figures** — confirmed by the client. Revenue, rates, folio balances, payments, COH, and expenses are all visible to `OWNER` in actual amounts, not just occupancy and volume counts. Do not build a "hide financials" mode.
**CASHIER vs ADMIN_STAFF — the split is money vs guest handling.** Both sit at the front desk and their roles overlap deliberately; a small property will often assign both roles to one person, and the union rule in §5.1 handles that. The distinction:
- `CASHIER` owns the money: manual booking entry, collecting and recording payments, posting and settling folio charges, and the shift cash count. Cashier **cannot** change room status or move work orders — nothing operational.
- `ADMIN_STAFF` owns the guest: inquiries, check-in/check-out paperwork (waiver, wristbands, key deposit), relaying requests to housekeeping, maintenance, and the kitchen.
- Neither may verify their own payments. `payment:verify` sits with `ADMIN_HEAD`, `RESORT_MANAGER`, and `OWNER`. Enforce separation explicitly: the API rejects a verify where `verifiedById === submittedById` with `403 SELF_VERIFICATION_FORBIDDEN`, even if the user somehow holds both permissions.
---
## 6. Data model
Prisma schema. Use `cuid()` ids. Every model gets `createdAt`, `updatedAt`, and `deletedAt?`.
```prisma
// ——— Identity & access ———
User            id, employeeCode, fullName, email?, phone?, passwordHash,
                department (enum), isActive, lastLoginAt, mustChangePassword
Role            id, key, label, description, isSystem
Permission      id, key, description, group
UserRole        userId, roleId
RolePermission  roleId, permissionId, scope (ALL|DEPARTMENT|SELF)
Session         id, userId, refreshTokenHash, expiresAt, revokedAt, userAgent, ip
AuditLog        id, actorId?, action, entity, entityId, before Json?, after Json?, ip, userAgent, createdAt
// ——— Property ———
UnitType        id, name, description?, defaultCapacity, baseRate,
                dayTourRate?, extraPersonRate?, colorHex?, isActive, sortOrder
                // e.g. "Standard Room", "Family Room", "Day Tour Cottage"
                // created and priced by SYSTEM_ADMIN / RESORT_MANAGER at runtime
Unit            id, code, name, unitTypeId, type (ROOM|COTTAGE|COMMON_AREA|FACILITY),
                capacity, floor?, status (enum), version, notes?, isActive, sortOrder
                // `capacity` defaults from UnitType.defaultCapacity but is overridable per unit
UnitStatusEvent id, unitId, fromStatus, toStatus, actorId, note?, createdAt
                // append-only; powers the room timeline + housekeeping productivity report
// ——— Guests & bookings ———
Booking         id, referenceNo (system-generated, e.g. LWW-2026-0417),
                guestName, guestPhone?, guestEmail?, source (WEBSITE|MESSENGER|WALK_IN|PHONE|OTA|OTHER),
                type (OVERNIGHT|DAY_TOUR), status (enum), pax, childrenPax,
                arrivalDate, departureDate, startAt, endAt,  // resolved datetimes, see §7.5
                totalAmount, notes?, createdById
BookingUnit     id, bookingId, unitId, rate  // a booking can hold multiple units
CheckInRecord   id, bookingId, checkedInAt, checkedInById, waiverSigned (bool),
                waiverFileId?, wristbandsIssued (int), keyDepositAmount,
                keyDepositReturned (bool), vehiclePlate?, idPresented (bool), notes?
CheckOutRecord  id, bookingId, checkedOutAt, checkedOutById, damagesNoted?, depositRefunded (bool)
// ——— Folio (running bill per booking) ———
FolioCharge     id, bookingId, source (ROOM|FNB|AMENITY|DEPOSIT|DAMAGE|PENALTY|MISC),
                sourceId?,          // fnbOrderId, amenityRequestId, etc.
                description, qty, unitPrice, amount,
                status (POSTED|VOIDED), postedById, postedAt,
                voidedById?, voidedAt?, voidReason?
                // amount is stored, never recomputed from the source row —
                // a menu price change next month must not rewrite last month's bill
FolioSettlement id, bookingId, paymentId, amount, settledById, settledAt
                // links a Payment to the folio; a booking may take several
Payment         id, bookingId?, amount, method (GCASH|BANK|CASH|CARD|OTHER),
                referenceNo?, proofFileId?, kind (DOWNPAYMENT|BALANCE|FULL|REFUND),
                status (PENDING|VERIFIED|REJECTED), submittedById, submittedAt,
                verifiedById?, verifiedAt?, rejectionReason?
// ——— Work ———
WorkOrder       id, referenceNo, type (HOUSEKEEPING|MAINTENANCE|AMENITY|GENERAL|SAFETY|DEEP_CLEAN),
                title, description?, priority (LOW|NORMAL|HIGH|URGENT),
                status (enum), version, unitId?, bookingId?,
                department (enum), createdById, assignedToId?, assignedById?,
                dueAt?, startedAt?, completedAt?, verifiedById?, verifiedAt?,
                attemptNo (int, default 1),  // increments on REOPENED
                isRecurring, recurrenceRule?  // simple RRULE subset for preventive maintenance
WorkOrderNote   id, workOrderId, authorId, body, fileId?, createdAt
WorkOrderPhoto  id, workOrderId, fileId, kind (ISSUE|PROGRESS|COMPLETION), uploadedById,
                caption?, capturedAt, attemptNo, createdAt
                // ISSUE     = the problem, attached at creation
                // PROGRESS  = optional, mid-repair
                // COMPLETION = the fix, attached when moving to DONE
// ——— Amenities ———
AmenityItem     id, name, category (CONSOLE|VIDEOKE|BOARD_GAME|OUTDOOR|OTHER),
                assetTag?, totalQty, condition, requiresDeposit, depositAmount, isActive
AmenityRequest  id, referenceNo, amenityItemId, bookingId?, unitId?, qty,
                status (REQUESTED|APPROVED|ISSUED|RETURNED|OVERDUE|CANCELLED|LOST_DAMAGED),
                requestedById, approvedById?, issuedById?, issuedAt?,
                dueBackAt?, returnedById?, returnedAt?, conditionOnReturn?, notes?
// ——— Restaurant ———
MenuItem        id, name, category, price, isAvailable, prepMinutes?, sortOrder
FnbOrder        id, referenceNo, bookingId?, unitId?, guestName?,
                type (DINE_IN|ROOM_SERVICE|ADVANCE_ORDER), scheduledFor?,
                settlement (PAY_NOW|CHARGE_TO_ROOM),
                status (RECEIVED|PREPARING|READY|SERVED|CANCELLED), version,
                subtotal, notes?, createdById, acknowledgedById?, acknowledgedAt?,
                preparingAt?, readyAt?, servedAt?
FnbOrderLine    id, fnbOrderId, menuItemId, qty, unitPrice, notes?
// ——— Stock (Phase 2, model now) ———
StockItem       id, name, category (CLEANING|MAINTENANCE|KITCHEN|OFFICE|OTHER),
                unitOfMeasure, currentQty, reorderLevel, isActive
StockMovement   id, stockItemId, delta, reason (RECEIVE|CONSUME|ADJUST|TRANSFER),
                workOrderId?, actorId, note?, createdAt
StockRequest    id, referenceNo, stockItemId, qty, status (REQUESTED|APPROVED|FULFILLED|REJECTED),
                requestedById, decidedById?, decidedAt?, note?
// ——— Shifts & attendance (Phase 2, model now) ———
Shift           id, userId, date, startTime, endTime, department, isReliever, note?
RestDayRequest  id, userId, requestedDate, reason?, status (PENDING|APPROVED|REJECTED),
                decidedById?, decidedAt?, decisionNote?
TimeLog         id, userId, clockInAt, clockOutAt?, source (WEB|MANUAL), note?
// ——— Cash & incidents (Phase 2, model now) ———
CashCount       id, shiftDate, department, openingAmount, closingAmount,
                countedById, verifiedById?, verifiedAt?, variance, note?
Expense         id, amount, category, description, receiptFileId?,
                incurredAt, recordedById, approvedById?, status
Incident        id, referenceNo, type (SAFETY|SECURITY|GUEST_COMPLAINT|POLICY_VIOLATION|INJURY),
                severity, description, location?, involvedUserId?, bookingId?,
                reportedById, status (OPEN|INVESTIGATING|RESOLVED), resolution?, resolvedAt?
Inspection      id, template (POOL|BEACH|PERIMETER|ROOM_QC|FACILITY),
                unitId?, checklist Json, passed (bool), inspectorId, notes?, createdAt
                // also carries the hourly swimmer count + patrol logs
// ——— System ———
Notification    id, userId, type, title, body, entityType?, entityId?, readAt?, createdAt
FileObject      id, filename, mimeType, sizeBytes, storageKey, uploadedById, createdAt
Setting         id, key, value Json, updatedById
```
### 6.1 Reference numbers
`WorkOrder`, `Booking`, `FnbOrder`, `AmenityRequest`, `StockRequest`, `Incident` each get a human-readable `referenceNo` (`WO-260821-0031`, `LWW-2026-0417`). Generate in a single shared service with a per-day sequence; staff will read these aloud over radio and type them into Messenger.
---
## 7. State machines
Implement each as an explicit transition table in `packages/shared` — a map of `{ from → allowed to[] }` plus the permission required. The API validates against the table; the UI derives available action buttons from the same table. **Never duplicate this logic.**
### 7.1 Unit status
```
VACANT_DIRTY → CLEANING → CLEANED → INSPECTED → READY → OCCUPIED → VACANT_DIRTY
```
Plus, from almost any state: `OUT_OF_ORDER` (broken, needs maintenance) and `BLOCKED` (closed deliberately — owner use, renovation, off-season). Return path from both is `VACANT_DIRTY`.
Rules:
- `CLEANING → CLEANED` requires `unit:update_status` (room attendant taps it).
- `CLEANED → INSPECTED` requires `workorder:verify` — this is the POC Housekeeping QC step described in the brief.
- `INSPECTED → READY` is automatic on inspection pass.
- `READY → OCCUPIED` happens automatically on booking check-in.
- `OCCUPIED → VACANT_DIRTY` happens automatically on check-out **and** auto-creates a `HOUSEKEEPING` work order for that unit.
- Setting `OUT_OF_ORDER` **requires** creating (or linking) a `MAINTENANCE` work order — enforce this; an out-of-order room with no ticket is how things get forgotten.
- A unit that is `OUT_OF_ORDER` or `BLOCKED` cannot be assigned to a new booking; the API returns `409` with a clear message.
### 7.2 Work order
```
OPEN → ASSIGNED → IN_PROGRESS → DONE → VERIFIED
         ↓            ↓           ↓
      CANCELLED    CANCELLED    REOPENED → IN_PROGRESS
```
- `DONE → VERIFIED` requires `workorder:verify`. Only the department POC or above may verify.
- `DONE → REOPENED` when QC fails; require a note.
- Urgent work orders push a realtime notification to everyone in the target department immediately.
- Track `slaBreached` as a computed field: `dueAt < now && status not in (DONE, VERIFIED, CANCELLED)`.
#### 7.2.1 Mandatory photo evidence
Photo evidence is a **hard gate on maintenance work**, enforced server-side in the transition service — never by disabling a button alone.
| Rule | Applies to |
|---|---|
| Creating the ticket requires **at least one `ISSUE` photo** | `type = MAINTENANCE` (also `SAFETY`) |
| Moving to `DONE` requires **at least one `COMPLETION` photo** | `type = MAINTENANCE` (also `SAFETY`, `DEEP_CLEAN`) |
| `PROGRESS` photos optional, any number, any time while `IN_PROGRESS` | all types |
| Photos encouraged but not required | `HOUSEKEEPING`, `AMENITY`, `GENERAL` |
- Which types require which photo kinds lives in a `Setting` (`workOrder.photoRequirements`), seeded with the table above, so the client can loosen or tighten it later without a deploy.
- Violations return `422` with `{ code: 'PHOTO_REQUIRED', details: { kind: 'COMPLETION' } }` and a message naming what's missing. The UI surfaces this as a blocking step in the Done flow, not a toast after the fact.
- Max 6 photos per kind per ticket. Max 10MB per file post-compression; reject other MIME types than `image/jpeg|png|webp|heic`.
- Store `capturedAt` from EXIF when present, falling back to upload time, and show both on the ticket if they differ by more than 24h — a "completion" photo taken three days before the ticket existed is the fraud case to catch.
- Photos are **immutable once the ticket is `VERIFIED`**. Before that, only the uploader (or a POC and above) may delete one, and the deletion is audited.
- If a ticket is `REOPENED`, the existing `COMPLETION` photos are retained and tagged to that attempt — add `attemptNo` (int, default 1) to `WorkOrderPhoto` and increment the ticket's attempt counter on reopen. The next `DONE` needs a **new** `COMPLETION` photo for the current attempt; a POC must be able to see attempt 1's photo next to attempt 2's.
### 7.3 F&B order
```
RECEIVED → PREPARING → READY → SERVED
    ↓          ↓
CANCELLED  CANCELLED
```
- `ADVANCE_ORDER` sits with `scheduledFor` set and surfaces in the kitchen board **90 minutes before** the scheduled time (make the lead time a `Setting`).
- Kitchen sees a live count of minutes-since-received per ticket; ≥20 min turns the card amber, ≥35 min red.
### 7.4 Amenity request
```
REQUESTED → APPROVED → ISSUED → RETURNED
                ↓         ↓
            CANCELLED  OVERDUE → RETURNED | LOST_DAMAGED
```
- Items with `requiresDeposit` cannot move to `ISSUED` without a recorded deposit amount.
- `ISSUED` past `dueBackAt` auto-flips to `OVERDUE` via `POST /api/v1/jobs/amenity-overdue`, called every 15 minutes by a Netlify Scheduled Function in production and triggered manually in local dev. Not a `setInterval` — see §3.1.
### 7.5 Booking windows & availability
Day tours are a **single fixed block, 9:00 AM – 5:00 PM** (confirmed by the client). There are no half-day or evening slots — do not build a slot picker.
- Store the window as `Setting` `booking.dayTourWindow = { start: "09:00", end: "17:00" }`. The cashier picks a date; the API resolves `startAt`/`endAt` from the setting. Hardcoding 9-to-5 anywhere outside that setting is a bug — an evening block is the most likely future request.
- Overnight bookings resolve from `Setting` `booking.checkInTime` (default 14:00) and `booking.checkOutTime` (default 12:00).
- **Availability is a datetime overlap check on `startAt`/`endAt` across `BookingUnit`**, not a date-equality comparison. A date-equality check would wrongly block a cottage that hosts a 9–5 day tour and an overnight stay starting at 14:00 on the same calendar day, which is a real thing this property does.
- **Turnaround buffer:** a unit cannot be assigned to a booking whose `startAt` falls within `Setting` `booking.turnaroundMinutes` (default 60) of the previous booking's `endAt`. Housekeeping needs that gap, and without the rule the system will cheerfully double-book across the 17:00 day-tour end and a same-evening arrival.
- A unit that is `OUT_OF_ORDER` or `BLOCKED` cannot be assigned at all. A unit that simply isn't `READY` yet at check-in raises a warning the front desk acknowledges rather than a hard block — real check-ins happen while the room is still being finished.
- Overlap violations return `409 UNIT_UNAVAILABLE` with the conflicting booking's `referenceNo` in `details`, so the cashier can see who already holds it instead of guessing.
### 7.6 Folio & settlement
The restaurant supports **both** immediate payment and charge-to-room settled at check-out (confirmed by the client), so a folio is required.
- `settlement = PAY_NOW` → the cashier records a `Payment` at the point of sale; no folio row is created.
- `settlement = CHARGE_TO_ROOM` → on transition to `SERVED`, the system auto-posts a `FolioCharge` (`source: FNB`, `sourceId: fnbOrder.id`) for the order subtotal.
- `CHARGE_TO_ROOM` is selectable only when the order links to a booking currently `CHECKED_IN`. Validate this **at order creation**, returning `422 NO_ACTIVE_FOLIO` — never at `SERVED`, because a kitchen ticket that can't be closed is worse than an order that can't be created.
- Amenity deposits, damage fees, and policy penalties post to the same folio with their own `source` values, so check-out settles one balance instead of four separate conversations.
- **Folio balance** = sum of `POSTED` charges − sum of `FolioSettlement` amounts against `VERIFIED` payments. Compute this in one shared service consumed by the API, the check-out screen, and the reports. Never re-implement the arithmetic.
- **Check-out is blocked while the balance is non-zero.** Only `folio:settle` holders may settle. `RESORT_MANAGER` and above may force check-out with an outstanding balance, which requires a reason and writes an audit entry.
- Charges are **voided, never deleted or edited.** A void needs `folio:void`, a reason, and leaves the original row visible on the bill.
- Show the running balance on the unit card in the Command Center for occupied rooms. The front desk should never be surprised at check-out.
---
## 8. Modules & screens
### 8.1 Shared shell
- Left/bottom nav is generated from the user's effective permissions. A user with two roles sees the union, not a duplicated menu.
- Global header: property status pill (`X occupied · Y ready · Z out of order`), notification bell, role switcher **only if** the user holds more than one role (switching filters the default dashboard view, it does not restrict permissions).
- A persistent **"+" quick action** button: Report an issue → opens the camera first, then unit picker and a one-line title. For maintenance the photo step is not skippable, so make it the first screen rather than an afterthought buried below the form. Every role has this.
### 8.2 Command Center (the main board)
The landing page for `RESORT_MANAGER`, `OPS_SAFETY_SUPERVISOR`, `ADMIN_HEAD`, `SYSTEM_ADMIN`, `OWNER`.
Layout, top to bottom:
1. **KPI strip** — Occupied / Ready / Dirty / Out-of-order counts · today's arrivals & departures · open urgent work orders · pending payment verifications · open F&B tickets.
2. **Unit grid** — a card per unit, colour + label coded by status, showing current guest name if occupied, and badges for open work orders / pending amenity returns. Tap → unit detail drawer with timeline, open tickets, and permitted status actions.
3. **Live activity feed** — realtime stream of status changes, new tickets, check-ins, order updates. Filterable by department.
4. **Attention queue** — SLA-breached work orders, overdue amenities, unverified payments >24h, rooms dirty >3h.
### 8.3 Role dashboards
Each is a filtered view over the same data — build **one** dashboard component with configurable widget sets, not thirteen bespoke pages.
- **Owner** — read-only Command Center + occupancy % trend (last 30 days), **revenue in actual pesos** by day, source, and unit type, folio receivables outstanding, department KPI cards, payment verification queue, export buttons. No action buttons anywhere else.
  - **Built for someone who is not on the property.** Assume the owner opens this once a day on a phone, possibly from another timezone, and wants the answer without hunting. Lead with a single "yesterday at a glance" card — occupancy, revenue, arrivals, incidents, anything still unverified — before any grid or chart.
  - **Daily digest.** Send a summary at 8:00 AM PHT (email in MVP; the channel is a `Setting`). An owner overseas should not have to remember to check a dashboard to learn that the generator failed. Include a deep link straight into the relevant record.
  - **Exception alerts, not noise.** Push immediately only for: an urgent work order open past its SLA, a forced check-out with an outstanding balance, a cash variance beyond a threshold, and a safety incident. Everything else waits for the digest.
- **Resort Manager** — Command Center + today's roster, pending rest-day requests, pending purchase/stock requests, COH summary, all-department report exports.
- **Ops & Safety Supervisor** — on-duty staff list, today's assigned tasks by person, tool/supply stock levels with reorder flags, COH check form, inspection checklists, incident log.
- **Admin Head** — arrivals/departures board, down-payment verification queue (website + waiver payments), receptionist activity log, consolidated daily report builder, incident/policy log.
- **Admin Staff** — split into three tabs: **Front Desk** (arrivals, check-in wizard with waiver/wristband/key-deposit checklist, check-out), **Inquiries** (booking create/edit, payment submit with proof upload), **Requests** (raise housekeeping/maintenance ticket, raise amenity request, place F&B order incl. advance orders). Plus a personal shift log listing every booking they touched by `referenceNo` + guest name.
- **Cashier** — the money desk, built for speed of manual entry:
  - **New booking form** as the primary action. Guest name, contact, source, type (Overnight / Day Tour), date(s), pax, unit picker showing live availability per §7.5, rate auto-filled from `UnitType` and overridable with a reason. Optimised for a walk-in guest standing at the counter — keyboard-navigable, no modal chains, saves in one submit.
  - **Payment entry** with method, reference number, and proof upload; the payment then sits `PENDING` for someone else to verify.
  - **Open folios** list showing every checked-in booking with its running balance; tap to view the itemised bill, post a misc charge, or settle.
  - **Shift cash count** — opening float, closing count, computed variance against recorded cash payments.
  - Cashier explicitly **cannot** change room status or touch work orders. If one person does both jobs, the system admin assigns both roles and the union rule in §5.1 gives them both surfaces.
- **POC Housekeeping** — room status board grouped by cleaning state, assignment panel (drag or tap-to-assign attendants), QC inspection queue for `CLEANED` rooms, deep-clean scheduler, cleaning-supply stock request, button to push a repair ticket straight to Maintenance.
- **Room Attendant** — a single list: "My rooms today", each with a Start / Done button and photo upload. Nothing else.
- **POC Maintenance** — incoming repair queue (from Housekeeping and Admin) with the issue photo as the card thumbnail, assignment panel, preventive-maintenance schedule (water, lighting, generator, AC), daily maintenance log submission, facility inspection form. The verify screen shows **issue and completion photos side by side** with a pinch-to-zoom lightbox — that comparison is the whole point of the QC step, so don't bury it behind a tab.
- **Maintenance Tech** — "My tickets today" list with Start / Done / add-photo / add-note. Tapping Done opens a camera-first completion sheet: capture or pick the completion photo, optional caption, then confirm. Never let the tech reach a dead end where Done is greyed out with no explanation — the sheet *is* the explanation.
**Photo capture UX (applies everywhere photos are taken):** use `<input type="file" accept="image/*" capture="environment">` so Android opens the camera directly, allow gallery fallback, compress client-side per §4.2 before upload, show a thumbnail with an upload progress bar, and retry failed uploads automatically. A tech standing in a generator room on one bar of signal must be able to queue the photo and walk away — if the upload fails, hold it in IndexedDB and retry on reconnect rather than losing the capture.
- **Resort Staff** — today's assigned grounds/cottage tasks, hourly pool & beach safety log form, wristband spot-check counter, perimeter patrol log, vehicle/guest entry log, "report an incident" button.
- **Restaurant Manager** — live order board, menu availability toggles, kitchen inventory, daily sales summary + export to Resort Manager.
- **Restaurant Staff** — kanban order board (Received → Preparing → Ready → Served) with large tap targets and an advance-order lane sorted by `scheduledFor`.
### 8.4 Reports & exports
Report builder with: date range, department, and type. Every report renders on screen **and** exports to CSV (Phase 1) and PDF (Phase 2).
MVP report set:
1. Occupancy & unit status history (by day, by unit).
2. Arrivals / departures / no-shows.
3. Payments received by method, source, and verification status.
4. Work orders: volume, by type, by department, average time-to-close, SLA breaches, top recurring units.
5. Housekeeping productivity: rooms cleaned per attendant, average clean time, QC pass rate.
6. Maintenance log by day — includes issue and completion photo thumbnails per ticket, so the day's log is visual evidence rather than a text list. CSV export carries authenticated photo URLs; the Phase 2 PDF export embeds the images two-up per ticket.
7. F&B orders: volume, revenue, average prep time, top items.
8. Amenity utilisation and loss/damage.
9. User activity / audit extract (SYSTEM_ADMIN, RESORT_MANAGER, OWNER only).
---
## 9. API surface
RESTful, all under `/api/v1`, all JSON, all authenticated except `/auth/login`.
```
POST   /auth/login | /auth/refresh | /auth/logout
GET    /auth/me                       → user + roles + effective permissions
GET    /users  POST /users  PATCH /users/:id  POST /users/:id/reset-password
GET    /roles  POST /roles  PATCH /roles/:id  PUT /roles/:id/permissions
GET    /permissions
GET    /unit-types  POST /unit-types  PATCH /unit-types/:id
GET    /units  POST /units  PATCH /units/:id
POST   /units/:id/status              { toStatus, note?, version }
GET    /units/:id/timeline
GET    /availability?from=&to=&type=  → per-unit availability per §7.5
GET    /bookings  POST /bookings  PATCH /bookings/:id
POST   /bookings/:id/check-in         { waiverSigned, wristbands, keyDeposit, ... }
POST   /bookings/:id/check-out
GET    /bookings/arrivals?date=
GET    /payments?status=pending  POST /payments
POST   /payments/:id/verify           { approve: bool, reason? }
GET    /bookings/:id/folio            → itemised charges, settlements, balance
POST   /bookings/:id/folio/charges    { source, description, qty, unitPrice }
POST   /bookings/:id/folio/charges/:chargeId/void   { reason }
POST   /bookings/:id/folio/settle     { paymentId, amount }
GET    /work-orders?type=&status=&assignedTo=&unitId=&mine=
POST   /work-orders
POST   /work-orders/:id/assign        { assignedToId }
POST   /work-orders/:id/status        { toStatus, note?, version }
POST   /work-orders/:id/notes
POST   /work-orders/:id/photos        { fileId, kind, caption? }  → 422 if kind not allowed yet
DELETE /work-orders/:id/photos/:photoId
GET    /amenities  POST /amenities
GET    /amenity-requests  POST /amenity-requests
POST   /amenity-requests/:id/status   { toStatus, ... }
GET    /menu-items  POST /menu-items  PATCH /menu-items/:id
GET    /fnb-orders?status=&scheduled=  POST /fnb-orders
POST   /fnb-orders/:id/status         { toStatus, version }
GET    /reports/:key?from=&to=&department=
GET    /reports/:key/export?format=csv
GET    /notifications  POST /notifications/:id/read
GET    /audit-logs?entity=&actorId=&from=&to=
GET    /settings  PUT /settings/:key
POST   /files  GET /files/:id
```
### 9.1 Socket.IO events
Namespace `/rt`. On connect, join `user:{id}`, `dept:{department}`, and `property`.
Emit: `unit.status.changed`, `workorder.created`, `workorder.assigned`, `workorder.status.changed`, `fnb.order.created`, `fnb.order.status.changed`, `amenity.request.changed`, `payment.submitted`, `payment.verified`, `booking.checked_in`, `booking.checked_out`, `notification.new`.
Every payload carries `{ entityId, actorId, at, summary }` — enough for the activity feed to render without a refetch, and enough of a cache key for TanStack Query to invalidate precisely.
---
## 10. Seed data
Create `apps/api/prisma/seed.ts` that seeds:
- All permissions and the 14 roles with the §5.4 matrix.
- One **placeholder** user per role, named after the role itself (`Resort Manager (Demo)`, `Room Attendant 1 (Demo)`), password `Waku2026!`, `mustChangePassword: true`, employee codes `LWW-001`… Do not seed any real staff name — real accounts are created by `SYSTEM_ADMIN` through the user management UI after handover.
- Unit types: `Standard Room`, `Family Room`, `Day Tour Cottage` with placeholder rates — **the client will create and price the real ones through the admin UI.**
- 13 rooms `R01`–`R13` and 3 cottages `C01`–`C03` as **placeholder units with placeholder names and capacities**. Real names, capacities, and tiering are entered by `SYSTEM_ADMIN` at setup — confirmed by the client. Make sure the unit management screen supports rename, re-code, capacity change, type reassignment, and reordering, because everything seeded here will be replaced on day one.
- Common areas: Pool, Beach Front, Open Field, CR-Male, CR-Female, Function Hall, Restaurant.
- ~12 amenity items: PS4/PS5 console, videoke unit ×2, 6 board games, beach volleyball set, kayak, billiard table.
- ~25 menu items across Rice Meals, Silog, Grilled, Pulutan, Drinks, Desserts.
- ~20 sample bookings spanning last week → next week, mixed overnight and 9–5 day-tour, mixed statuses, including at least one cottage holding a day tour and an overnight stay on the same date so the overlap logic in §7.5 is visibly exercised.
- Two checked-in bookings carrying open folios with a mix of F&B, amenity deposit, and misc charges, one of them partially settled — so the check-out block and balance arithmetic are testable on first run.
- ~30 work orders across all states, some SLA-breached, some maintenance tickets carrying placeholder issue photos and (where `DONE`/`VERIFIED`) completion photos, plus at least one reopened ticket at `attemptNo: 2` so the multi-attempt photo comparison is visible on first run.
- A handful of pending payments with placeholder proof images.
Seed must be **idempotent** (`upsert` on natural keys) and re-runnable.
---
## 11. Milestones
Complete each milestone fully — including its tests — before starting the next. Commit at the end of each with a conventional-commit message.
- **M0 — Scaffold.** Monorepo, Prisma schema (all enums typed — no `String` stand-ins), `RealtimeAdapter` and `StorageAdapter` interfaces with **Supabase implementations only**, `netlify.toml` and the `serverless-http` function wrapper written to spec but **not deployed**, ESLint/Prettier, health check, test runner wired up. Acceptance: `npm run dev` boots web + api against the hosted Supabase dev project; `GET /api/v1/health` returns 200 and reports adapter resolution; a file uploads and reads back through `StorageAdapter` against real Supabase Storage; a realtime event round-trips through `RealtimeAdapter` against real Supabase Realtime; **both round-trip tests actually execute and pass rather than skipping** — a skipped test is not a passing test; `npm test` runs green on Node 24; a grep for `setInterval`, `setTimeout(`-based scheduling, and module-level mutable caches comes back clean.
- **M1 — Auth, RBAC & hardening.** User/Role/Permission models, login, refresh, `requirePermission` middleware, seed script, admin UI for users & roles, audit log middleware, plus the §3.1.1 security set: login rate limiting and lockout, TOTP 2FA enforced for `OWNER` and `SYSTEM_ADMIN`, session list with remote revocation, HTTPS/HSTS/secure cookies. Acceptance: login as each seeded role and see a correctly filtered nav; a `403` is returned when calling an endpoint outside your permission set; every mutation appears in `AuditLog`; an owner account cannot complete login without a TOTP code; revoking a session from another device invalidates its refresh token immediately; 10 failed logins lock the account and the attempts are visible in the audit log.
- **M2 — Units & Command Center.** Unit model, status state machine, unit grid, unit detail drawer, timeline, realtime status updates. Acceptance: two browsers open the grid; a status change in one appears in the other within 2s without refresh; an invalid transition is rejected with a readable message; a stale `version` returns `409`.
- **M3 — Work orders.** Full ticket lifecycle, department routing, assignment, photo evidence, notes, SLA flag, department dashboards for Housekeeping and Maintenance, "My tasks" list for staff. Acceptance: check-out auto-creates a housekeeping ticket; setting a unit `OUT_OF_ORDER` requires a linked maintenance ticket; a POC can assign, a tech can complete, a POC can verify or reopen; **a maintenance ticket cannot be created without an `ISSUE` photo and cannot reach `DONE` without a `COMPLETION` photo — both enforced by an API test that posts without the photo and asserts `422`, not just by a disabled button**; reopening a ticket increments `attemptNo` and requires a fresh completion photo; the verify screen shows both photos side by side.
- **M4 — Bookings, check-in/out, payments, folio.** Unit types with rates, unit management UI, availability engine per §7.5, booking CRUD via the cashier form, arrivals board, check-in wizard with waiver/wristband/deposit checklist, folio charges and settlement, check-out, payment submit with proof upload, verification queue for Owner/Admin Head. Acceptance: a full booking → payment → verify → check-in → charge → settle → check-out → auto-dirty cycle completes and every step is audited; **a 9–5 day tour and a 14:00 overnight arrival can both be booked on the same cottage the same day, while a second overlapping booking returns `409`**; check-out is refused with a non-zero folio balance; a manager can force it with a reason and the override appears in the audit log; a user holding both submit and verify permissions is still refused self-verification.
- **M5 — Restaurant & amenities.** Menu, order creation from Admin Staff and Cashier, `PAY_NOW` vs `CHARGE_TO_ROOM` settlement, kitchen kanban with realtime, advance orders, amenity catalogue, request → issue → return with deposits and overdue job. Acceptance: an order placed by Admin Staff appears on the kitchen board in <2s; a `CHARGE_TO_ROOM` order auto-posts a folio charge on `SERVED` and shows up on the guest's bill; selecting `CHARGE_TO_ROOM` without an active checked-in booking is refused at creation; an advance order surfaces at its lead time; an overdue amenity flips state automatically.
- **M6 — Reports, remote monitoring & polish.** Report builder, all nine MVP reports, CSV export, notifications, owner daily digest and exception alerts, PWA manifest + install prompt with read-only offline cache of the last-known board, empty states, loading skeletons, error boundaries, mobile pass on every screen. Acceptance: every report renders and exports with correct Asia/Manila date bucketing **when the browser is set to a non-PHT timezone** — test with `TZ=America/Los_Angeles`; the digest sends at 08:00 PHT with working deep links; Lighthouse mobile performance ≥85.
- **M6.5 — Client review.** Hand the local build to the client to use against real scenarios before any cloud spend. Expect changes: unit names and rates, wording, which fields the cashier actually needs, dashboard layout, report columns. Budget a round of revisions here rather than treating M6 as final. This is the whole reason the cloud step sits after it.
- **M7 — Launch.** Only once the client has used the local build and signed off. See §11.1.
### 11.1 Launch checklist (M7)
Nothing here is code — it is the cutover, and it is the first time real money is spent.
1. **Upgrade the existing Supabase dev project to Pro** (~$25/mo). The project was created at M0 in `ap-northeast-1` (Tokyo) — not the `ap-southeast-1` (Singapore) originally planned; see §3.1 — and is already the one holding the data, so do **not** create a second project. Free tier auto-pauses after 7 days idle and will take the resort offline on a quiet week. Decide deliberately whether to wipe development data first: if the client has been entering real bookings during M6.5 review, keep it; if it is demo noise, reset and reseed.
2. **Upgrade Netlify to a paid plan and set the functions region to `ap-northeast-1`** (Project configuration → Build & deploy → Functions region), then redeploy — region changes only apply to new deploys. Verify the change took effect before going further; leaving functions in Ohio while the database is in Tokyo is the single biggest avoidable performance mistake in this build.
3. **Set both spend caps low** before the first deploy.
4. **Confirm the pooled and direct Prisma URLs** are still correct after the Pro upgrade (`6543` with `?pgbouncer=true&connection_limit=1` for `DATABASE_URL`; `5432` for `DIRECT_URL`), and run migrations against the production branch.
5. **Verify connection pooling under load** — hit an endpoint 50+ times in sequence and confirm no connection exhaustion. **This cannot be tested locally**; the local stack has no pooler in front of it, so the bug is invisible until it is in production, usually a day or two in. Do this before staff are on the system, not after.
6. **Confirm the Netlify Scheduled Functions** for the amenity-overdue sweep and the owner digest are registered and each fires once against the deployed endpoints.
7. **Confirm no public storage buckets** — payment proofs and waivers must 401 when fetched without a session.
8. **Force HTTPS/HSTS, secure cookies**, and confirm 2FA enrolment works for the Owner and System Admin accounts from a non-PHT network if possible.
9. **Run a report with the browser set to a non-PHT timezone** and confirm date bucketing still follows Asia/Manila.
10. **Set up the off-site `pg_dump`** in addition to Supabase's own backups, and test a restore once. An untested backup is not a backup.
11. **Rotate every seeded password**, delete the demo placeholder users, and confirm each real staff account was created by the system admin with the right roles.
12. **Load the real property data** — unit types with real rates, real unit names and capacities, real menu, real amenity inventory.
**Phase 2 backlog (model the tables in M0, build later):** stock & purchasing, shift roster + reliever assignment + DTR, rest-day requests, COH/expense workflow, incident & inspection forms, hourly pool/beach logs, perimeter patrol log, PDF exports, BIR/SSS/PhilHealth/Pag-IBIG compliance exports, Messenger booking-inquiry intake.
---
## 12. Working agreement for Claude Code
1. **Read this whole file before writing anything.** Produce a plan and an assumptions list first; wait for approval.
2. Work **one milestone at a time**. Do not scaffold ahead into future milestones.
3. **Ask before adding any dependency** not listed in §3 — with these already approved, no need to ask: `serverless-http` (Express → Netlify Function wrapper), `@netlify/functions` (types and scheduled-function helpers), `netlify-cli` (dev dependency), `otplib` or `otpauth` (TOTP for §3.1.1 2FA), `express-rate-limit` (login throttling), `resend` (owner digest email, M6 only), `date-fns-tz` or `@date-fns/tz` (Asia/Manila boundary maths per §3.2). Anything else, stop and ask.
4. Shared types, zod schemas, permission keys, and state-transition tables live in `packages/shared` and are imported by both apps. If you find yourself duplicating a union type or a status list, stop and move it.
5. Write the API test alongside the endpoint, not after. Every state transition needs a happy-path test and a rejected-transition test.
6. Prefer boring, readable code. No premature abstraction, no clever generics, no service-locator patterns. This system will be maintained by one developer on a phone-heavy schedule.
7. Keep files under ~300 lines. Split by feature, not by layer (`apps/api/src/modules/work-orders/{router,service,schema,test}.ts`).
8. Never bypass `requirePermission`. Never trust `role` from the client. Never hide a button as the only form of authorization.
9. **No individual staff names in code, schema, seed, comments, or UI copy** — not in enums, not in conditionals, not in test fixtures. Roles are positions; the people holding them will change. Anything that reads "the manager" must resolve through a role or permission lookup at runtime.
10. Seed data must stay in sync with the schema — update `seed.ts` in the same commit as any model change.
11. Update `README.md` at the end of each milestone with what now works and how to run it.
---
## 13. Confirmed decisions
All six original open questions have been answered by the client. These are settled — build to them, do not re-litigate.
| # | Decision | Where it lands in this spec |
|---|---|---|
| 1 | **Rooms and capacities are entered by the system admin**, not hardcoded. Tiering is handled by admin-created `UnitType` records with their own rates. | §6 `UnitType`/`Unit`, §10 seed, M4 |
| 2 | **Day tours are a single 9:00 AM – 5:00 PM block.** No slots, no evening block. | §7.5, `Setting booking.dayTourWindow` |
| 3 | **Cloud only: Netlify + Supabase.** The driving reason is that the owner and system admin must monitor the resort from off-site and from overseas, which an on-prem box cannot serve well. Adapter interfaces stay; on-prem implementations are not built. | §1, §3.0, §3.1, §3.1.1, M0 |
| 4 | **Restaurant supports both pay-now and charge-to-room settled at check-out.** A folio is required. | §6 `FolioCharge`/`FolioSettlement`, §7.6, M4/M5 |
| 5 | **Owner sees actual peso figures**, not just occupancy and volume. | §5.4 note, Owner dashboard in §8.3 |
| 6 | **No data migration.** Bookings are manually entered by a new `CASHIER` role. `referenceNo` is system-generated with no external format to match. | §5.2 `CASHIER`, §5.4, §8.3 Cashier dashboard |
### 13.1 Consequences worth flagging
- **Decision 3 is now settled rather than deferred.** Remote monitoring by the owner and system admin — including from overseas — is the reason this is a hosted app at all, so an on-prem box is out. What remains from the earlier dual-target work is the pair of adapter interfaces, which cost almost nothing and keep a future move cheap. Do not build the Socket.IO or local-disk implementations.
- **Being internet-exposed is the cost of that decision.** Guest data, payment proofs, and revenue figures now sit behind a public login, so §3.1.1 is part of M1 rather than a hardening pass at the end. Bolting 2FA onto a shipped auth system is materially harder than building it in.
- **Timezone handling stops being cosmetic.** An owner abroad opening the dashboard is the exact case where device-local date bucketing silently shows the wrong day's numbers. M6 acceptance tests this with a non-PHT `TZ`.
- **Decision 1 means the seeded units are throwaway.** The unit management screen is a first-class feature, not an admin afterthought — the client's very first session with the system is renaming 16 units. It needs to be usable on a phone.
- **Decision 4 turns check-out into a financial gate.** Once charge-to-room exists, check-out cannot be a simple status flip; it has to check a balance. This is the main reason M4 grew.
- **Decision 6 makes the cashier form the highest-traffic screen in the system.** Every booking in the property passes through it by hand. It deserves more design attention than any dashboard.
- **The Supabase region landed in Tokyo, not Singapore.** §3.1 originally called for `ap-southeast-1` as the geographically closest region to the property. The project that actually exists is in `ap-northeast-1`. Region is fixed at creation, so the spec now follows the real project; the Netlify Functions region at M7 must match it (`ap-northeast-1`), and the region-mismatch dev-latency trade-off described in §3.1 applies the same way, just against Tokyo instead of Singapore.
### 13.2 Still open (do not block on these; defaults are in the spec)
1. **Expected concurrent staff account count** was not given. The spec assumes 15–30 users and a peak of ~10 simultaneous sessions. Both deployment targets handle this comfortably, so it only matters if the real number is an order of magnitude higher.
2. **Rate rules beyond a flat per-unit-type rate** — weekend, holiday, and peak-season pricing, extra-person charges, and group discounts. MVP stores a single `baseRate` and `dayTourRate` per unit type with a manual override (plus a reason) at booking time. If the resort prices by season, that becomes a rate-calendar feature in Phase 2.
3. **Whether the cashier may apply discounts**, and if so whether a manager must approve them. MVP allows a rate override with a mandatory reason, audited. Tighten if the client wants approval flow.
4. **Deposit and cancellation policy** — how much down payment is required to hold a booking, and what happens to it on a no-show. MVP records payments without enforcing a policy.
