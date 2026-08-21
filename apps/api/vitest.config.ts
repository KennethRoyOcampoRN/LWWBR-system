import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

// vitest doesn't read apps/api/.env on its own — loadEnv (from vite, an
// existing transitive dep, no new package needed) does, so the round-trip
// tests in test/adapters/*.roundtrip.test.ts can see real Supabase
// credentials instead of always skipping.
export default defineConfig(({ mode }) => ({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    env: loadEnv(mode, process.cwd(), ''),
  },
}));
