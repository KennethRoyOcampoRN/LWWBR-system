import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Client decision, 2026-10-27 (spec.md §13 decision 11): LAN_MODE is the
// explicit, visible opt-in for the mini PC's deliberately plain-HTTP
// deployment — this exercises all three places it has to change
// behavior together (forceHttps's 403, the cookie Secure flag, and
// helmet's HSTS header), confirming a cloud deployment (LAN_MODE unset)
// is completely unaffected and still forces HTTPS exactly as before.
//
// vi.resetModules() + a dynamic re-import per test, not module-level
// imports: getEnv() caches its result in a module singleton, so without
// a fresh module graph each test's process.env changes would be ignored
// after the first call anywhere in this file — the same reason
// forceHttps.ts and cookies.ts read process.env directly rather than
// through getEnv() for exactly these two flags.
//
// Deliberately surgical about process.env: only the specific keys this
// file touches are saved and restored, never `process.env` wholesale —
// vitest can run multiple test files in the same worker process, and a
// blanket `process.env = {...snapshot}` risks clobbering ambient state
// a sibling file depends on that this file never knew about.
const TOUCHED_KEYS = ['NODE_ENV', 'LAN_MODE', 'DATABASE_URL', 'DIRECT_URL', 'JWT_SECRET'] as const;
const savedEnv: Partial<Record<(typeof TOUCHED_KEYS)[number], string | undefined>> = {};

function setBaseEnv() {
  process.env.NODE_ENV = 'production';
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  process.env.DIRECT_URL = 'postgresql://test:test@localhost:5432/test';
  process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long-ok';
}

describe('LAN_MODE', () => {
  beforeEach(() => {
    for (const key of TOUCHED_KEYS) savedEnv[key] = process.env[key];
    vi.resetModules();
    setBaseEnv();
  });

  afterEach(() => {
    for (const key of TOUCHED_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  describe('forceHttps', () => {
    it('403s a plain HTTP request in production when LAN_MODE is unset — unaffected cloud behavior', async () => {
      delete process.env.LAN_MODE;
      const { createApp } = await import('../src/app.js');
      const res = await request(createApp()).get('/api/v1/health');
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('HTTPS_REQUIRED');
    });

    it('allows a plain HTTP request in production when LAN_MODE=true', async () => {
      process.env.LAN_MODE = 'true';
      const { createApp } = await import('../src/app.js');
      const res = await request(createApp()).get('/api/v1/health');
      expect(res.status).toBe(200);
    });
  });

  describe('helmet HSTS header', () => {
    it('is sent when LAN_MODE is unset — unaffected cloud behavior (helmet runs before forceHttps, so the header is present even on its 403)', async () => {
      delete process.env.LAN_MODE;
      const { createApp } = await import('../src/app.js');
      const res = await request(createApp()).get('/api/v1/health');
      expect(res.headers['strict-transport-security']).toBeDefined();
    });

    it('is never sent when LAN_MODE=true — a browser must not be told to require HTTPS on a deliberately plain-HTTP origin', async () => {
      process.env.LAN_MODE = 'true';
      const { createApp } = await import('../src/app.js');
      const res = await request(createApp()).get('/api/v1/health');
      expect(res.headers['strict-transport-security']).toBeUndefined();
    });
  });

  describe('cookies.ts Secure flag', () => {
    it('is off when LAN_MODE=true, even in production — a Secure cookie would never be sent over plain HTTP', async () => {
      process.env.LAN_MODE = 'true';
      const { setAccessCookie } = await import('../src/modules/auth/cookies.js');
      const cookieCalls: unknown[][] = [];
      const fakeRes = { cookie: (...args: unknown[]) => cookieCalls.push(args) };
      setAccessCookie(fakeRes as never, 'token-value');
      const options = cookieCalls[0]?.[2] as { secure: boolean };
      expect(options.secure).toBe(false);
    });

    it('is on in production when LAN_MODE is unset — unaffected cloud behavior', async () => {
      delete process.env.LAN_MODE;
      const { setAccessCookie } = await import('../src/modules/auth/cookies.js');
      const cookieCalls: unknown[][] = [];
      const fakeRes = { cookie: (...args: unknown[]) => cookieCalls.push(args) };
      setAccessCookie(fakeRes as never, 'token-value');
      const options = cookieCalls[0]?.[2] as { secure: boolean };
      expect(options.secure).toBe(true);
    });
  });
});
