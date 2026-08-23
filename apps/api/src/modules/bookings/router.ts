import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { requirePermission } from '../auth/requirePermission.js';
import { createBookingSchema } from './schema.js';
import { createBooking, listUpcomingBookingsForUnit } from './service.js';

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

// Gated on unit:read, not booking:read — this is fundamentally "does
// this unit have a reservation," the same kind of unit-level fact the
// units module's own /units/:id/timeline already answers, not a
// booking-resource read. A Room Attendant (HOUSEKEEPING_STAFF) who
// holds unit:read but never booking:read still needs to see this — real
// gap found live-testing: "a cashier or housekeeper looking at the
// Units page has no way to know a room has an upcoming booking at all."
// Lives on the bookings router (not units/router.ts) since it queries
// Booking/BookingUnit, which this module owns — mounted at a /units/...
// path is fine, Express doesn't care which router file declares a path.
bookingsRouter.get(
  '/units/:id/bookings',
  requirePermission('unit:read'),
  asyncHandler(async (req, res) => {
    const bookings = await listUpcomingBookingsForUnit(req.params.id as string);
    res.status(200).json({ bookings });
  }),
);
