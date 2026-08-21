import { config } from 'dotenv';
import { resolve } from 'node:path';

// vitest doesn't read apps/api/.env on its own — without this, the adapter
// round-trip tests in test/adapters/*.roundtrip.test.ts silently skip even
// when real Supabase credentials are present in .env, because
// process.env.SUPABASE_URL etc. are simply never set in the test process.
config({ path: resolve(import.meta.dirname, '../.env') });
