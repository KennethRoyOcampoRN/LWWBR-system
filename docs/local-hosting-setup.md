# Local hosting setup — the mini PC

Client decision, 2026-10-27 (spec.md §13 decision 11): the resort runs
self-hosted on a dedicated mini PC on-site rather than cloud (Netlify +
Supabase). This is a step-by-step setup guide for standing that up —
the mini PC's own launch checklist, parallel to spec.md §11.1's (now
dormant) cloud one.

Who this is for: whoever physically sets up the mini PC. No deep
Node/Postgres/Windows-admin background assumed, but comfort with a
terminal and Windows Services/Task Scheduler is expected.

## 1. Prerequisites on the mini PC

- **Windows** (this guide assumes Windows — the app itself is
  cross-platform, but NSSM and Task Scheduler below are Windows-
  specific; a Linux mini PC would use systemd + cron instead, not
  covered here).
- **Node.js 24** (the version pinned in `.nvmrc`/`package.json`
  `engines`). Install from nodejs.org, or via `nvm-windows` if you
  might ever need multiple Node versions. Verify with `node --version`.
- **PostgreSQL 16**. Install from postgresql.org's Windows installer
  (the EnterpriseDB one). During setup it registers itself as a Windows
  service with **Automatic** startup — leave that as the installer sets
  it; this is what makes Postgres itself come back after a reboot with
  no manual step.
- **Git**, to clone the repo.
- An external USB/network drive for nightly backups (see §5).

## 2. Database setup

Open `psql` (or pgAdmin, whichever you're comfortable with) as the
Postgres superuser and create a dedicated role and database:

```sql
CREATE DATABASE lwwbr;
CREATE USER lwwbr WITH PASSWORD '<pick-a-real-password>';
GRANT ALL PRIVILEGES ON DATABASE lwwbr TO lwwbr;
\c lwwbr
GRANT ALL ON SCHEMA public TO lwwbr;
```

No Supabase-style pooler is needed here — that split (`DATABASE_URL`
on port 6543 with `pgbouncer`, `DIRECT_URL` on 5432) was specifically a
serverless-cold-start workaround for the Netlify path. A single long-
running process talking to a local database doesn't need it;
`DATABASE_URL` and `DIRECT_URL` can be identical.

## 3. Clone and configure

```powershell
git clone <repo-url> C:\LWWBR\app
cd C:\LWWBR\app
npm install
```

Copy `apps/api/.env.example` to `apps/api/.env` and fill in real
values. The example file's *active* (uncommented) block is already
written for this exact deployment — self-hosted, local disk, Socket.IO,
`LAN_MODE=true` — so mostly this means replacing placeholder secrets
with real ones:

- `DATABASE_URL` / `DIRECT_URL` — `postgresql://lwwbr:<password>@localhost:5432/lwwbr`
- `FILE_SIGNING_SECRET`, `JWT_SECRET`, `JOB_SECRET` — generate each with
  `openssl rand -base64 48` (or `node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"`
  if openssl isn't installed). **Never reuse the placeholder values** —
  a weak or shared secret lets anyone forge an access token or a
  signed file link.
- `UPLOADS_DIR` — where photos/selfies land on disk. Point this
  somewhere on the mini PC's main drive (e.g. `C:\LWWBR\uploads`); the
  nightly backup script (§5) copies this directory separately from the
  database dump.
- Leave `RESEND_API_KEY`/`OWNER_DIGEST_FROM_EMAIL` unset unless you're
  specifically testing the (dormant, per spec.md §13 decision 8) owner
  digest — it needs real internet regardless of hosting mode, since
  email always does.

`apps/web/.env` is not needed at all for this deployment — the
frontend talks to the API same-origin, no separate config.

## 4. First-time database schema + seed

```powershell
cd apps/api
npx prisma db push
npm run seed      # only if this is a fresh database with no real data yet
```

`prisma db push` works identically against local Postgres as it did
against Supabase — the schema has no RLS, no Postgres extensions, no
Supabase-specific column types, so nothing here needed to change.

## 5. Build

From the repo root:

```powershell
npm run build
```

This builds `packages/shared`, `apps/api` (to `apps/api/dist`), and
`apps/web` (to `apps/web/dist`). The self-hosted API process serves
`apps/web/dist` directly (see `SERVE_WEB_DIST=true` in `.env`) — there's
no separate Netlify CDN anymore, no separate step to "deploy" the
frontend. A re-build after pulling new code is just `npm run build`
again, then restarting the Windows service (§6).

## 6. Running it as a Windows service — NSSM

The app must come back up automatically after a power outage or a
Windows update, with nobody physically at the machine to start it.

**NSSM (Non-Sucking Service Manager)** wraps the Node process as a real
Windows service: starts before any user logs in, survives reboots,
auto-restarts on crash. This is the recommended choice over PM2 —
PM2 isn't native to Windows (no systemd-equivalent it hooks into; it
needs a community wrapper like `pm2-installer` to become a real
service) — and over a plain Task Scheduler "at startup" trigger — Task
Scheduler doesn't manage process lifecycle (auto-restart on crash)
anywhere near as cleanly as a real service manager does. NSSM is
boring and bulletproof, which is exactly the property "must survive a
3am power cut" needs.

1. Download NSSM from nssm.cc, extract it somewhere permanent (e.g.
   `C:\NSSM`).
2. Open an elevated (Administrator) PowerShell:
   ```powershell
   C:\NSSM\nssm.exe install LWWBR-API
   ```
   This opens a GUI. Set:
   - **Path**: `C:\Program Files\nodejs\node.exe`
   - **Startup directory**: `C:\LWWBR\app\apps\api`
   - **Arguments**: `dist\index.js`
   - On the **Details** tab, set Startup type to **Automatic**.
   - On the **I/O** tab, optionally redirect stdout/stderr to log files
     (e.g. `C:\LWWBR\logs\api.out.log` / `api.err.log`) — useful for
     diagnosing a crash after the fact.
3. Start it: `C:\NSSM\nssm.exe start LWWBR-API`, or via
   `services.msc`.
4. Confirm: open a browser on the mini PC itself to
   `http://localhost:3001` — you should see the app's login screen.
   From another device on the same LAN, `http://<mini-pc-LAN-IP>:3001`.

To update after a code change: stop the service, `git pull`,
`npm install` (if dependencies changed), `npm run build`, start the
service again.

## 7. Scheduled jobs — Windows Task Scheduler

Netlify Scheduled Functions don't exist in this deployment. The jobs
they used to trigger (`amenity-overdue`, `exception-alerts`) are
already plain `JOB_SECRET`-protected HTTP endpoints — built that way
specifically so the trigger mechanism is swappable — so this is Task
Scheduler calling the same endpoints on the same cadence, nothing in
the app itself changed.

For each of the two jobs, create a Task Scheduler task:

- **Trigger**: Daily, repeat every 15 minutes, indefinitely (matches
  the previous `netlify.toml` cadence).
- **Action**: Start a program —
  `powershell.exe -Command "Invoke-RestMethod -Method Post -Uri http://localhost:3001/api/v1/jobs/amenity-overdue -Headers @{'x-job-secret'='<JOB_SECRET value>'}"`
  (swap the URL path for `exception-alerts` on the second task).
- **General tab**: "Run whether user is logged on or not", and check
  "Run with highest privileges" if needed. This is what makes the task
  fire even when nobody is signed into Windows at the time.

Use the exact `JOB_SECRET` value from `apps/api/.env` — a mismatch
401s silently from the task's point of view (Task Scheduler doesn't
surface HTTP error bodies by default; check the API's own log if a job
doesn't seem to be firing).

## 8. Backups — local and cloud

**Nightly local dump, no internet required.** A PowerShell script,
run via Task Scheduler (daily, e.g. 3:00 AM):

```powershell
# backup-local.ps1
$stamp = Get-Date -Format "yyyy-MM-dd_HHmm"
$backupRoot = "E:\LWWBR-Backups"  # the external drive's path
pg_dump -U lwwbr -h localhost lwwbr > "$backupRoot\db-$stamp.sql"
robocopy "C:\LWWBR\uploads" "$backupRoot\uploads-$stamp" /MIR
# Prune anything older than 30 days so the external drive doesn't fill silently.
Get-ChildItem $backupRoot -Filter "db-*.sql" | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-30) } | Remove-Item
Get-ChildItem $backupRoot -Directory -Filter "uploads-*" | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-30) } | Remove-Item -Recurse
```

Register this as a Task Scheduler task the same way as the job pings
above (daily trigger, "run whether user is logged on or not"). This
needs no internet connection at all — it only touches the local
database and the external drive.

**Opportunistic cloud copy, decoupled from a live connection.**
[`rclone`](https://rclone.org) syncs the external drive's backup
folder to a **fresh Backblaze B2 bucket** (client's explicit call —
not Supabase, specifically to avoid keeping a cloud dependency alive
in a system being deliberately taken off the cloud's critical path).
One-time setup:

```powershell
rclone config
# Create a new remote, type "b2", paste in the Backblaze
# applicationKeyId / applicationKey from the B2 dashboard.
```

Then a second Task Scheduler task (e.g. hourly), running:

```powershell
rclone sync E:\LWWBR-Backups lwwbr-b2:lwwbr-backups --log-file=C:\LWWBR\logs\rclone.log
```

`rclone sync` only transfers what's new or changed and simply does
nothing (no error) when there's no connection — the next successful
run picks up wherever it left off. No custom outage-handling logic is
needed; this is exactly the "catches up after outages" behavior rclone
is built for.

## 9. Network — wifi SSID segmentation

This deployment runs plain HTTP (`LAN_MODE=true` in `.env` — see
spec.md §13 decision 11 for why: geofencing was the only real argument
for HTTPS here, and that's dropped anyway per decision 10). Plain HTTP
means login credentials and session cookies are readable to anyone who
can sniff traffic on the same network segment.

**Put the mini PC and staff devices on a separate wifi SSID from the
guest network.** This is a router/access-point configuration change,
not anything in this codebase — removes the sniffing risk without
installing certificates on every staff phone. Worth doing regardless
of anything else in this guide; if the resort's current setup has
staff and guests sharing one SSID, this is the first thing to fix,
before or alongside standing up the app itself.

## 10. TeamViewer — the owner's and client's only route in

Since the mini PC isn't reachable over the public internet, TeamViewer
(or an equivalent remote-desktop tool) is how the owner and client
actually reach the system. For this to work without someone physically
at the resort:

- Install TeamViewer (or the host's chosen equivalent) on the mini PC
  with a **permanent** license/ID, not a session-based one.
- Enable **"Start TeamViewer with Windows"** (its own setting, under
  Extras → Options → General) so it's running before anyone logs into
  Windows — same "survives a reboot with nobody there" requirement as
  the app itself.
- Set up **unattended access**: TeamViewer → Extras → Options →
  Security → "Grant easy access" or set a personal password for
  unattended access, so a connection doesn't need someone on-site to
  click "accept" each time.
- If the mini PC auto-logs-in to a Windows user account on boot (a
  reasonable choice for a single-purpose machine with no one routinely
  sitting at it), confirm TeamViewer's unattended-access service is
  configured to run regardless of whether that user is logged in —
  there's a separate Windows service option for this in TeamViewer's
  settings, distinct from "start with Windows" for the login-session
  app.
- Write down the TeamViewer ID and password somewhere both the owner
  and the client can retrieve it — if that's lost and the mini PC is
  unreachable, there's no outside way back in to this deployment.

## 11. Smoke-test checklist

Before considering the mini PC live:

- [ ] Reboot the mini PC (or `shutdown /r`) and confirm, without
      touching anything, that: Postgres comes back (`pg_isready`),
      the LWWBR-API service shows Running in `services.msc`, and
      `http://localhost:3001` serves the login screen within a minute
      or two of boot.
- [ ] Log in from a second device on the same LAN (confirms the
      service is actually reachable over the network, not just
      `localhost`).
- [ ] Clock in with a selfie on a phone — confirms the camera capture
      (`capture="user"`), the file upload, and the local-disk storage
      round-trip all work.
- [ ] Open the Units page on two devices at once, change a unit's
      status on one, and confirm the other updates live within a
      couple of seconds — confirms Socket.IO is actually connected,
      not silently falling back to the 60-second poll the whole time.
- [ ] Manually trigger each scheduled job once
      (`Invoke-RestMethod` as in §7, or right-click → Run in Task
      Scheduler) and confirm a `200`, not a `401` (wrong `JOB_SECRET`)
      or connection error.
- [ ] Run the nightly backup script once by hand and confirm a new
      `.sql` dump and an `uploads-*` folder actually appear on the
      external drive.
- [ ] Run the rclone sync once by hand and confirm the files actually
      appear in the Backblaze B2 bucket.
- [ ] Confirm TeamViewer unattended access actually works from a
      network *other* than the resort's own (e.g. a phone on mobile
      data) — this is the real test of "the owner's and client's only
      route in."
- [ ] Confirm staff phones are on the separate wifi SSID (§9), not the
      guest network.

## Known pre-existing gaps, unrelated to this migration

Two things noticed while building this, worth flagging rather than
quietly working around:

- **`StorageAdapter`'s own doc comment claims every file read goes
  through an authenticated `/files/:id` route — that route was never
  actually built.** `getSignedUrl()`'s result (Supabase's own signed
  URL in the cloud path; `GET /api/v1/files/signed` here) is handed
  directly to the browser as a raw `<a href>`/`<img src>`, bypassing
  session auth entirely — the signature and expiry *are* the
  credential. This local-disk signed-URL route deliberately replicates
  that actual behavior (short-lived, unguessable, not session-gated),
  not the stricter spec'd-but-never-built one — fixing that gap was
  judged out of scope for this migration, not an oversight.
- **A real bug caught only by manual end-to-end verification, not by
  any mocked test**: `LocalDiskStorageAdapter.getSignedUrl()` originally
  minted a link at `/files/signed`, missing the `/api/v1` prefix the
  route is actually mounted under (`app.ts`:
  `app.use('/api/v1', filesRouter)`). The link silently resolved to the
  SPA's own `index.html` fallback instead of the file — in a real
  browser, a selfie photo would have just shown nothing, with no error
  anywhere. Fixed, and now covered by both a unit test (asserting the
  URL's prefix) and a real supertest-against-the-actual-route test —
  but worth remembering that an adapter's own unit tests passing is not
  the same guarantee as the route it's wired into actually working.
