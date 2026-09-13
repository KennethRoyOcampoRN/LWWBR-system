// Client-directed feature, 2026-09-18: DTR geofence check. Standard
// great-circle (Haversine) distance between two lat/lng points, in
// meters — used both server-side (dtr/service.ts, to decide whether a
// clock-in/out falls inside the configured geofence) and available here
// so the frontend could preview the same math if ever needed. Pure
// function, no I/O, so it's trivially unit-testable against known
// coordinate pairs.
const EARTH_RADIUS_METERS = 6_371_000;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

export function haversineDistanceMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_METERS * c;
}

export interface Geofence {
  centerLat: number;
  centerLng: number;
  radiusMeters: number;
}

// Strict `>` (outside), not `>=` — a point exactly on the boundary counts
// as inside, same "boundary belongs to the inclusive side" convention as
// stock's low-stock `<` threshold (that one excludes the boundary;
// they're different comparisons, but both were a deliberate, tested
// choice, not an accident).
export function isWithinGeofence(lat: number, lng: number, geofence: Geofence): boolean {
  return haversineDistanceMeters(lat, lng, geofence.centerLat, geofence.centerLng) <= geofence.radiusMeters;
}

// Client follow-up, 2026-09-13: multiple named geofences replace the
// single one — "inside any one counts," so a location is only ever
// considered outside if it misses every configured fence. An empty
// list is vacuously "not within any," which is correct here: the
// caller (dtr/service.ts) is expected to check for an empty list
// separately before treating that as a flaggable miss, since an
// unconfigured property has nothing to be outside of.
export function isWithinAnyGeofence(lat: number, lng: number, geofences: Geofence[]): boolean {
  return geofences.some((geofence) => isWithinGeofence(lat, lng, geofence));
}
