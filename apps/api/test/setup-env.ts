import { config } from 'dotenv';
import { resolve } from 'node:path';

// vitest doesn't read apps/api/.env on its own — without this, the adapter
// round-trip tests in test/adapters/*.roundtrip.test.ts silently skip even
// when real Supabase credentials are present in .env, because
// process.env.SUPABASE_URL etc. are simply never set in the test process.
config({ path: resolve(import.meta.dirname, '../.env') });

// TEMPORARY diagnostic — not for the final commit. Prints a stack trace at
// the exact call site of realtime-js's send()-falls-back-to-REST warning,
// so we can find the real caller instead of guessing. Remove once found.
const originalWarn = console.warn;
console.warn = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].includes('automatically falling back to REST')) {
    originalWarn('[diagnostic] send()-fallback warning triggered from:', new Error().stack);
  }
  originalWarn(...args);
};
