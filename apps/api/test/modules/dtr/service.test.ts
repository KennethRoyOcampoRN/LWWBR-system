import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockPrisma = {
  geofence: { findMany: vi.fn() },
};
vi.mock('../../../src/lib/prisma.js', () => ({ prisma: mockPrisma }));

// Client decision, 2026-10-27 (spec.md §13 decision 10): dormant,
// together with the rest of the geofence/flagging mechanism, on the
// LAN_MODE mini PC deployment — geolocation needs a secure origin,
// which that deployment deliberately doesn't have. GEOFENCE_CHECK_
// ENABLED=false must turn the *whole* mechanism off, not just the
// geolocation half: with location always unavailable, leaving flagging
// on would mark every clock-in/out NO_LOCATION forever.
//
// vi.resetModules() + a dynamic re-import per test: getEnv() caches its
// result in a module singleton, so without a fresh module graph a
// changed GEOFENCE_CHECK_ENABLED would be ignored after the first call
// anywhere in this file.
//
// Deliberately surgical about process.env (see lanMode.test.ts's own
// comment on why): only the specific keys this file touches are saved
// and restored, never `process.env` wholesale.
const TOUCHED_KEYS = ['GEOFENCE_CHECK_ENABLED', 'DATABASE_URL', 'DIRECT_URL', 'JWT_SECRET'] as const;
const savedEnv: Partial<Record<(typeof TOUCHED_KEYS)[number], string | undefined>> = {};

function setBaseEnv() {
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  process.env.DIRECT_URL = 'postgresql://test:test@localhost:5432/test';
  process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long-ok';
}

describe('dtr/service checkLocation — GEOFENCE_CHECK_ENABLED', () => {
  beforeEach(() => {
    for (const key of TOUCHED_KEYS) savedEnv[key] = process.env[key];
    vi.resetModules();
    vi.clearAllMocks();
    setBaseEnv();
  });

  afterEach(() => {
    for (const key of TOUCHED_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it('never flags, and never even queries geofences, when GEOFENCE_CHECK_ENABLED=false — even with fences configured and no location', async () => {
    process.env.GEOFENCE_CHECK_ENABLED = 'false';
    mockPrisma.geofence.findMany.mockResolvedValue([
      { id: 'geo_1', name: 'Main Resort', centerLat: 13.75, centerLng: 121.05, radiusMeters: 200 },
    ]);
    const { checkLocation } = await import('../../../src/modules/dtr/service.js');

    const result = await checkLocation({});

    expect(result).toEqual({ flagged: false, reason: null });
    expect(mockPrisma.geofence.findMany).not.toHaveBeenCalled();
  });

  it('flags NO_LOCATION for a missing location when GEOFENCE_CHECK_ENABLED is unset — unaffected cloud/HTTPS behavior', async () => {
    delete process.env.GEOFENCE_CHECK_ENABLED;
    mockPrisma.geofence.findMany.mockResolvedValue([
      { id: 'geo_1', name: 'Main Resort', centerLat: 13.75, centerLng: 121.05, radiusMeters: 200 },
    ]);
    const { checkLocation } = await import('../../../src/modules/dtr/service.js');

    const result = await checkLocation({});

    expect(result).toEqual({ flagged: true, reason: 'NO_LOCATION' });
  });
});
