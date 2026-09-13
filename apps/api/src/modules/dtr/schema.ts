import { z } from 'zod';

// Selfie photo is a hard requirement, not a configurable setting — the
// client's own wording ("a selfie photo requirement") reads as fixed,
// and there's no reason yet to make it toggleable. lat/lng are optional:
// a browser that denies/fails geolocation must never block a real clock-
// in/out (see dtr/service.ts's own header comment) — the request still
// succeeds, it just can't be geofence-checked, and gets flagged instead.
const clockEventSchema = z.object({
  photoFileId: z.string().min(1),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
});

export const clockInSchema = clockEventSchema;
export type ClockInInput = z.infer<typeof clockInSchema>;

export const clockOutSchema = clockEventSchema;
export type ClockOutInput = z.infer<typeof clockOutSchema>;

export const listTimeLogsQuerySchema = z.object({
  userId: z.string().min(1).optional(),
  flaggedOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  // Client follow-up, 2026-09-13: bounds the new "all time logs" audit
  // view so it doesn't fetch the property's entire DTR history
  // unbounded as the pilot accumulates data. Same YYYY-MM-DD convention
  // as reports/schema.ts's reportQuerySchema. Both optional — the
  // existing self-scoped "my recent time logs" list and the flagged-
  // only queue never pass these, so their behavior is unchanged.
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'from must be YYYY-MM-DD').optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'to must be YYYY-MM-DD').optional(),
});
export type ListTimeLogsQuery = z.infer<typeof listTimeLogsQuerySchema>;

export const reviewTimeLogSchema = z.object({
  reviewNote: z.string().trim().max(500).optional(),
});
export type ReviewTimeLogInput = z.infer<typeof reviewTimeLogSchema>;

// Client follow-up, 2026-09-13: named geofences replace the single
// centerLat/centerLng/radiusMeters Setting value — same three numeric
// fields, now one of potentially many, each with a name so an admin can
// tell "Main Resort" apart from "Maria's Home" in the list UI.
export const geofenceInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  centerLat: z.number().min(-90).max(90),
  centerLng: z.number().min(-180).max(180),
  radiusMeters: z.number().positive(),
});
export type GeofenceInput = z.infer<typeof geofenceInputSchema>;

// Client follow-up, 2026-09-13: a pre-check the client calls before
// actually clocking in/out, purely so it can warn the person in the
// moment ("you appear to be outside a known work location") instead of
// only a reviewer finding out later. Deliberately the same lat/lng
// shape as clockEventSchema — both optional, since a denied/failed
// geolocation call must be checkable too (that's the NO_LOCATION case).
export const checkLocationSchema = z.object({
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
});
export type CheckLocationInput = z.infer<typeof checkLocationSchema>;
