import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { requireAuth } from '../auth/middleware.js';
import { requirePermission } from '../auth/requirePermission.js';
import {
  checkLocationSchema,
  clockInSchema,
  clockOutSchema,
  geofenceInputSchema,
  listTimeLogsQuerySchema,
  reviewTimeLogSchema,
} from './schema.js';
import {
  checkLocation,
  clockIn,
  clockOut,
  createGeofence,
  deleteGeofence,
  listFlaggedTimeLogs,
  listGeofences,
  listTimeLogs,
  reviewTimeLog,
  updateGeofence,
} from './service.js';

export const dtrRouter = Router();

// Client-directed feature, 2026-09-18: DTR clock-in/out. requireAuth
// only, no shift:* permission — logging your own hours isn't a
// permission-scoped action, same precedent as GET /auth/sessions
// (self-service, scoped by identity, not a grant). See dtr/service.ts's
// own header comment for the never-block-only-flag geofence design.
dtrRouter.post(
  '/time-logs/clock-in',
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = clockInSchema.parse(req.body);
    const timeLog = await clockIn(body, { id: req.userId as string });
    res.status(201).json({ timeLog });
  }),
);

dtrRouter.post(
  '/time-logs/clock-out',
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = clockOutSchema.parse(req.body);
    const timeLog = await clockOut(body, { id: req.userId as string });
    res.status(200).json({ timeLog });
  }),
);

// Client follow-up, 2026-09-13: a pre-check the client calls right
// before clocking in/out, so it can warn the person in the moment
// instead of only a reviewer finding out later. requireAuth only, same
// self-service precedent as clock-in/out itself — and deliberately
// returns no geofence data (see service.ts's own header comment on why
// leaking configured location names/coordinates to every employee would
// be an unnecessary exposure).
dtrRouter.post(
  '/dtr/check-location',
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = checkLocationSchema.parse(req.body);
    res.status(200).json(await checkLocation(body));
  }),
);

// requirePermission('shift:read') just to get req.authUser populated
// with a fresh permission set — shift:read is the universal floor, so
// this never actually refuses anyone; the real scoping (own records vs
// everyone's) happens inside listTimeLogs based on shift:manage.
dtrRouter.get(
  '/time-logs',
  requirePermission('shift:read'),
  asyncHandler(async (req, res) => {
    const query = listTimeLogsQuerySchema.parse(req.query);
    const timeLogs = await listTimeLogs(query, {
      id: req.authUser!.id,
      canManage: Boolean(req.authUser!.permissions['shift:manage']),
    });
    res.status(200).json({ timeLogs });
  }),
);

dtrRouter.get(
  '/time-logs/flagged',
  requirePermission('shift:manage'),
  asyncHandler(async (_req, res) => {
    res.status(200).json({ timeLogs: await listFlaggedTimeLogs() });
  }),
);

dtrRouter.post(
  '/time-logs/:id/review',
  requirePermission('shift:manage'),
  asyncHandler(async (req, res) => {
    const body = reviewTimeLogSchema.parse(req.body);
    const timeLog = await reviewTimeLog(req.params.id as string, body, { id: req.authUser!.id });
    res.status(200).json({ timeLog });
  }),
);

// Client-directed feature, 2026-09-18 (client follow-up, 2026-09-13:
// now a list of named geofences, not one setting) — System-Admin-
// configurable, the first real use of system:configure, which existed
// as a permission key but had never been wired to an endpoint before
// this feature.
dtrRouter.get(
  '/dtr/geofences',
  requirePermission('system:configure'),
  asyncHandler(async (_req, res) => {
    res.status(200).json({ geofences: await listGeofences() });
  }),
);

dtrRouter.post(
  '/dtr/geofences',
  requirePermission('system:configure'),
  asyncHandler(async (req, res) => {
    const body = geofenceInputSchema.parse(req.body);
    const geofence = await createGeofence(body);
    res.status(201).json({ geofence });
  }),
);

dtrRouter.patch(
  '/dtr/geofences/:id',
  requirePermission('system:configure'),
  asyncHandler(async (req, res) => {
    const body = geofenceInputSchema.parse(req.body);
    const geofence = await updateGeofence(req.params.id as string, body);
    res.status(200).json({ geofence });
  }),
);

dtrRouter.delete(
  '/dtr/geofences/:id',
  requirePermission('system:configure'),
  asyncHandler(async (req, res) => {
    await deleteGeofence(req.params.id as string);
    res.status(204).send();
  }),
);
