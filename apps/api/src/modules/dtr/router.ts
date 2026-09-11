import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { requireAuth } from '../auth/middleware.js';
import { requirePermission } from '../auth/requirePermission.js';
import {
  clockInSchema,
  clockOutSchema,
  geofenceSettingSchema,
  listTimeLogsQuerySchema,
  reviewTimeLogSchema,
} from './schema.js';
import {
  clockIn,
  clockOut,
  getGeofenceSetting,
  listFlaggedTimeLogs,
  listTimeLogs,
  reviewTimeLog,
  setGeofenceSetting,
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

// Client-directed feature, 2026-09-18: the resort's DTR geofence,
// System-Admin-configurable — the first real use of system:configure,
// which existed as a permission key but had never been wired to an
// endpoint before this.
dtrRouter.get(
  '/dtr/geofence-setting',
  requirePermission('system:configure'),
  asyncHandler(async (_req, res) => {
    res.status(200).json({ geofence: await getGeofenceSetting() });
  }),
);

dtrRouter.put(
  '/dtr/geofence-setting',
  requirePermission('system:configure'),
  asyncHandler(async (req, res) => {
    const body = geofenceSettingSchema.parse(req.body);
    const geofence = await setGeofenceSetting(body, { id: req.authUser!.id });
    res.status(200).json({ geofence });
  }),
);
