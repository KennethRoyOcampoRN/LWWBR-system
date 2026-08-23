import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { requirePermission } from '../auth/requirePermission.js';
import { createBookingSchema } from './schema.js';
import { createBooking } from './service.js';

export const bookingsRouter = Router();

// First M4 slice, spec §6/§7.5: booking creation with real availability
// checking. requirePermission already loaded req.authUser fresh from the
// database — reused here rather than a second getMe() call, same
// pattern as every other create route in this codebase.
bookingsRouter.post(
  '/bookings',
  requirePermission('booking:create'),
  asyncHandler(async (req, res) => {
    const body = createBookingSchema.parse(req.body);
    const booking = await createBooking(body, req.authUser!);
    res.status(201).json({ booking });
  }),
);
