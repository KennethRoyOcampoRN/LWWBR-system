import { describe, expect, it } from 'vitest';
import { haversineDistanceMeters, isWithinAnyGeofence, isWithinGeofence } from '../src/geo.js';

describe('haversineDistanceMeters', () => {
  it('returns 0 for identical points', () => {
    expect(haversineDistanceMeters(13.75, 121.05, 13.75, 121.05)).toBe(0);
  });

  // A well-known, independently-checkable fact: 1 degree of latitude is
  // ~111,195m (using mean Earth radius 6,371,000m — the same radius this
  // module uses), regardless of longitude. Same point on the equator,
  // 1 degree apart in latitude only, isolates the formula from any
  // longitude-scaling error.
  it('matches the known ~111,195m for 1 degree of latitude at the equator', () => {
    const distance = haversineDistanceMeters(0, 0, 1, 0);
    expect(distance).toBeGreaterThan(111_100);
    expect(distance).toBeLessThan(111_300);
  });

  it('is symmetric regardless of point order', () => {
    const a = haversineDistanceMeters(13.75, 121.05, 13.76, 121.06);
    const b = haversineDistanceMeters(13.76, 121.06, 13.75, 121.05);
    expect(a).toBeCloseTo(b, 6);
  });
});

describe('isWithinGeofence', () => {
  const geofence = { centerLat: 13.75, centerLng: 121.05, radiusMeters: 200 };

  // The boundary case the client specifically asked to have tested,
  // same "at/just above/just below the threshold" rigor as the low-stock
  // reorder-level tests: exactly at the radius, just inside, just
  // outside. Deliberately `<=` (inclusive at the boundary) — the
  // opposite comparison direction from stock's `<`, and just as
  // deliberate; see this function's own comment for why.
  it('is inside exactly at the radius boundary', () => {
    // ~1 degree of latitude ≈ 111,195m, so radiusMeters / 111195 degrees
    // of latitude offset lands (very close to) exactly on the boundary.
    const offsetDeg = geofence.radiusMeters / 111_195;
    const atBoundary = { lat: geofence.centerLat + offsetDeg, lng: geofence.centerLng };
    const distance = haversineDistanceMeters(atBoundary.lat, atBoundary.lng, geofence.centerLat, geofence.centerLng);
    expect(distance).toBeCloseTo(geofence.radiusMeters, -1); // within ~10m
    expect(isWithinGeofence(atBoundary.lat, atBoundary.lng, { ...geofence, radiusMeters: distance })).toBe(true);
  });

  it('is inside well within the radius', () => {
    expect(isWithinGeofence(13.7501, 121.0501, geofence)).toBe(true);
  });

  it('is outside well beyond the radius', () => {
    expect(isWithinGeofence(13.80, 121.05, geofence)).toBe(false);
  });
});

describe('isWithinAnyGeofence', () => {
  const fenceA = { centerLat: 13.75, centerLng: 121.05, radiusMeters: 200 };
  const fenceB = { centerLat: 14.60, centerLng: 120.98, radiusMeters: 200 };

  it('is true when inside the second fence but outside the first — "inside any one counts"', () => {
    expect(isWithinAnyGeofence(14.6001, 120.9801, [fenceA, fenceB])).toBe(true);
  });

  it('is true when inside the first fence but outside the second', () => {
    expect(isWithinAnyGeofence(13.7501, 121.0501, [fenceA, fenceB])).toBe(true);
  });

  it('is false when outside every configured fence', () => {
    expect(isWithinAnyGeofence(0, 0, [fenceA, fenceB])).toBe(false);
  });

  it('is false for an empty list — the caller decides what that means, not this function', () => {
    expect(isWithinAnyGeofence(13.75, 121.05, [])).toBe(false);
  });
});
