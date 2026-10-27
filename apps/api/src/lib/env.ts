import { z } from 'zod';

// z.coerce.boolean() is a trap for a string-valued env var: it's just
// `Boolean(value)`, so the literal string "false" coerces to `true`
// (a non-empty string is always truthy) — found while testing
// GEOFENCE_CHECK_ENABLED=false below, which this would have silently
// treated as "on". This only ever accepts the literal strings "true"/
// "false" and defaults when the var is unset entirely.
function booleanFlag(defaultValue: boolean) {
  return z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? defaultValue : v === 'true'));
}

// Read once per cold start — this is plain config loading, not the
// request-scoped mutable state the spec (§3.1) warns against. Nothing here
// changes between requests within a single invocation.
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().min(1),
  DIRECT_URL: z.string().min(1),
  // Client decision, 2026-10-27 (spec.md §13 decision 11): local self-
  // hosting on a mini PC, not a Netlify/Supabase reversal of this file's
  // validation — StorageAdapter/RealtimeAdapter stay swappable, so the
  // Supabase credentials below are now optional at the schema level
  // (same optional-then-checked-at-use-site pattern as JOB_SECRET and
  // RESEND_API_KEY) rather than required, and only matter when
  // STORAGE_ADAPTER/REALTIME_ADAPTER actually select 'supabase'.
  SUPABASE_URL: z.string().min(1).optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  SUPABASE_STORAGE_BUCKET: z.string().default('lwwbr-files'),
  // Which StorageAdapter/RealtimeAdapter implementation getStorageAdapter()/
  // getRealtimeAdapter() resolve to. Defaults preserve the original cloud
  // behavior for any deployment that doesn't set these explicitly.
  STORAGE_ADAPTER: z.enum(['supabase', 'local']).default('supabase'),
  REALTIME_ADAPTER: z.enum(['supabase', 'socketio']).default('supabase'),
  // Local-disk StorageAdapter only. Directory is created on first use if
  // missing — see localDiskStorageAdapter.ts.
  UPLOADS_DIR: z.string().default('./uploads'),
  // Signs the local-disk StorageAdapter's signed-URL tokens (HMAC over
  // key+expiry) — see localDiskStorageAdapter.ts's own header comment for
  // why this needed a real signing step rather than a bare file path.
  // Optional at the schema level, checked explicitly when STORAGE_ADAPTER
  // is 'local', same pattern as JOB_SECRET.
  FILE_SIGNING_SECRET: z.string().min(32, 'FILE_SIGNING_SECRET must be at least 32 characters').optional(),
  JOB_SECRET: z.string().min(1).optional(),
  // Signs access tokens (spec §3: "Application-level JWT... argon2
  // password hashing"). Refresh tokens are opaque random strings, hashed
  // with SHA-256 (not argon2 — they're already high-entropy secrets, not
  // low-entropy user passwords) before being stored in Session.
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  // Client decision, 2026-10-27 (spec.md §13 decision 11): explicit
  // opt-in for the mini PC's plain-HTTP LAN deployment — forceHttps.ts
  // and cookies.ts both gate on this rather than loosening their
  // NODE_ENV==='production' default, so a cloud deployment keeps forcing
  // HTTPS unconditionally and this deployment's plain-HTTP posture stays
  // a deliberate, visible opt-in rather than a silently weakened default.
  LAN_MODE: booleanFlag(false),
  // Client decision, 2026-10-27 (spec.md §13 decision 10): geolocation
  // requires a secure origin, which this deployment deliberately doesn't
  // have — see dtr/service.ts's own header comment. Defaults to on
  // (unaffected cloud/HTTPS behavior); the mini PC's own .env sets this
  // to false so flagging goes dormant together with geolocation, rather
  // than flagging every single clock-in forever.
  GEOFENCE_CHECK_ENABLED: booleanFlag(true),
  // Owner daily digest (spec §8.3, M6). Optional at the schema level,
  // same pattern as JOB_SECRET — checked explicitly at the point the
  // digest actually tries to send, so the app still boots without them
  // and every other endpoint is unaffected if they're never configured.
  // Client decision, 2026-10-27 (spec.md §13 decision 11): the self-
  // hosted mini PC entrypoint (src/index.ts) serves the built SPA from
  // this same process/port when this is on — off by default so ordinary
  // `npm run dev` (Vite serving the frontend separately, proxying /api
  // here) is unaffected. WEB_DIST_DIR is resolved relative to this
  // file's own directory at runtime.
  SERVE_WEB_DIST: booleanFlag(false),
  WEB_DIST_DIR: z.string().default('../../web/dist'),
  RESEND_API_KEY: z.string().min(1).optional(),
  OWNER_DIGEST_FROM_EMAIL: z.string().email().optional(),
  // Base URL for the deep links the digest embeds (e.g.
  // `${WEB_BASE_URL}/work-orders?id=...`) — the API has no other way to
  // know its own web app's public origin.
  WEB_BASE_URL: z.string().url().optional(),
});

export type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | undefined;

export function getEnv(): Env {
  if (!cachedEnv) {
    cachedEnv = envSchema.parse(process.env);
  }
  return cachedEnv;
}
