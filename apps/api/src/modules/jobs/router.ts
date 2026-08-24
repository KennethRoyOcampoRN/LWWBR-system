import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { applyAmenityOverdueSweep } from '../amenities/service.js';
import { requireJobSecret } from './middleware.js';

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
