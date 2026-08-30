import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { applyAmenityOverdueSweep } from '../amenities/service.js';
import { requireJobSecret } from './middleware.js';
import { sendOwnerDigest } from './ownerDigest.js';
import { runExceptionAlertsSweep } from './service.js';

export const jobsRouter = Router();

// Spec §7.4/§3.1: "ISSUED past dueBackAt auto-flips to OVERDUE via
// POST /api/v1/jobs/amenity-overdue, called every 15 minutes by a
// Netlify Scheduled Function in production and triggered manually in
// local dev." This route is the trigger; applyAmenityOverdueSweep (see
// amenities/service.ts) is the actual bulk update.
jobsRouter.post(
  '/jobs/amenity-overdue',
  requireJobSecret,
  asyncHandler(async (_req, res) => {
    res.status(200).json(await applyAmenityOverdueSweep());
  }),
);

// Spec §8.3: "Push immediately only for: an urgent work order open past
// its SLA..." Same plain-HTTP-job shape as amenity-overdue above — see
// jobs/service.ts's runExceptionAlertsSweep for what this actually does
// and why a sweep, not an event, is the right trigger for this
// particular alert.
jobsRouter.post(
  '/jobs/exception-alerts',
  requireJobSecret,
  asyncHandler(async (_req, res) => {
    res.status(200).json(await runExceptionAlertsSweep());
  }),
);

// Spec §8.3: "Send a summary at 8:00 AM PHT (email in MVP; the channel
// is a Setting)." Same plain-HTTP-job shape as amenity-overdue — the
// Netlify Scheduled Function *file* itself stays deferred to M7 launch
// config (netlify.toml already has the `owner-digest` schedule entry,
// inert until then), same as amenity-overdue's own. See
// jobs/ownerDigest.ts for the actual content/send logic.
jobsRouter.post(
  '/jobs/owner-digest',
  requireJobSecret,
  asyncHandler(async (_req, res) => {
    res.status(200).json(await sendOwnerDigest());
  }),
);
