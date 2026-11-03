// @vitest-environment node
//
// Loading the real vite.config.ts pulls in Vite's own esbuild-backed
// config loader, which doesn't tolerate jsdom's TextEncoder (this
// suite's default test environment) — node is this file's own
// environment override, scoped to just this file via the directive
// above, not a change to every other test's jsdom default.
import { describe, expect, it } from 'vitest';
import config from '../vite.config.js';

// Client bug report, 2026-11-03: both `server.host: true` and the `/rt`
// WebSocket proxy entry kept getting silently reverted on pull (each
// was only ever applied by hand, locally, never committed) — the first
// broke LAN access to the dev server entirely, the second made
// realtime silently fall back to the 60s poll in dev with no error,
// easy to mistake for "just slow" rather than "not connected at all".
//
// Deliberately cheap, not a full E2E harness (flagged as disproportionate
// by the client for this): this only proves the *config* regression
// can't happen silently again — it does not prove the proxy actually
// connects end to end at runtime. That would need a real dev server +
// a real API server + a real socket.io-client running together, which
// is the heavier harness the client explicitly said not to ask for.
describe('vite.config.ts dev server settings', () => {
  it('binds the dev server to all interfaces (server.host), not just localhost', () => {
    expect(config.server?.host).toBe(true);
  });

  it('proxies /rt (Socket.IO) to the API server, as a WebSocket upgrade', () => {
    const rtProxy = config.server?.proxy?.['/rt'];
    expect(rtProxy).toBeDefined();
    expect(typeof rtProxy === 'object' ? rtProxy.ws : undefined).toBe(true);
    expect(typeof rtProxy === 'object' ? rtProxy.target : undefined).toBe('http://localhost:3001');
  });

  it('still proxies /api to the API server — unaffected by the /rt addition', () => {
    expect(config.server?.proxy?.['/api']).toBe('http://localhost:3001');
  });
});
