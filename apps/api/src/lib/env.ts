import { z } from 'zod';

// Read once per cold start — this is plain config loading, not the
// request-scoped mutable state the spec (§3.1) warns against. Nothing here
// changes between requests within a single invocation.
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().min(1),
  DIRECT_URL: z.string().min(1),
  SUPABASE_URL: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_STORAGE_BUCKET: z.string().default('lwwbr-files'),
  JOB_SECRET: z.string().min(1).optional(),
  // Signs access tokens (spec §3: "Application-level JWT... argon2
  // password hashing"). Refresh tokens are opaque random strings, hashed
  // with SHA-256 (not argon2 — they're already high-entropy secrets, not
  // low-entropy user passwords) before being stored in Session.
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
});

export type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | undefined;

export function getEnv(): Env {
  if (!cachedEnv) {
    cachedEnv = envSchema.parse(process.env);
  }
  return cachedEnv;
}
