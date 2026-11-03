/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    // Client fix, 2026-11-03: without this the dev server only binds
    // localhost, so a phone on the resort LAN can't reach it at all —
    // only the machine running `npm run dev` itself could. This keeps
    // getting reverted on every pull because it was only ever applied
    // by hand locally; committing it here is the actual fix.
    host: true,
    proxy: {
      '/api': 'http://localhost:3001',
      // Client fix, 2026-11-03: the Socket.IO client connects to /rt on
      // the page's own origin (:5173 in dev — see apps/web/src/lib/
      // realtime.ts's io() call, which passes no explicit URL). Without
      // this proxy entry that request has nowhere to go in dev (the
      // real Socket.IO server lives on :3001, and only /api was
      // forwarded), so realtime silently never connected and every
      // dev session quietly fell back to the 60-second poll the whole
      // time — a room status change took up to a minute to reach a
      // second device, easy to mistake for "it's just slow" rather
      // than "it's not actually connected". `ws: true` is required
      // because this is a WebSocket upgrade, not a plain HTTP proxy.
      // Production is unaffected — SERVE_WEB_DIST (spec.md §13
      // decision 11) serves the SPA and the API from the same :3001
      // origin there, so there's no cross-origin proxy involved at all.
      '/rt': { target: 'http://localhost:3001', ws: true },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
  },
});
