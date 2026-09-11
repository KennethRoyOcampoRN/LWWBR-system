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
});
export type ListTimeLogsQuery = z.infer<typeof listTimeLogsQuerySchema>;

export const reviewTimeLogSchema = z.object({
  reviewNote: z.string().trim().max(500).optional(),
});
export type ReviewTimeLogInput = z.infer<typeof reviewTimeLogSchema>;

export const geofenceSettingSchema = z.object({
  centerLat: z.number().min(-90).max(90),
  centerLng: z.number().min(-180).max(180),
  radiusMeters: z.number().positive(),
});
export type GeofenceSettingInput = z.infer<typeof geofenceSettingSchema>;
