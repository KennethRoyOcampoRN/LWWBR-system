import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { requirePermission } from '../auth/requirePermission.js';
import { checkInBookingSchema, checkOutBookingSchema, createBookingSchema, searchBookingsQuerySchema } from './schema.js';
import {
  checkInBooking,
  checkOutBooking,
  createBooking,
  getBooking,
  listUpcomingBookingsForUnit,
  searchBookings,
} from './service.js';

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

// Powers the "guest name lookup" half of check-in. No route-ordering
// concern with GET /bookings/:id below — `search` is a query param, not
// a path segment, so there's no :id-swallowing risk like the
// /work-orders/assignable-users case earlier this session.
bookingsRouter.get(
  '/bookings',
  requirePermission('booking:read'),
  asyncHandler(async (req, res) => {
    const query = searchBookingsQuerySchema.parse(req.query);
    const bookings = await searchBookings(query.search);
    res.status(200).json({ bookings });
  }),
);

// `:id` accepts either the cuid or the human-readable referenceNo — see
// findBookingWithUnits's own doc comment in service.ts.
bookingsRouter.get(
  '/bookings/:id',
  requirePermission('booking:read'),
  asyncHandler(async (req, res) => {
    const booking = await getBooking(req.params.id as string);
    res.status(200).json({ booking });
  }),
);

// Urgent gap, 2026-08-23: "with check-in not yet built, there's
// currently no way to process this guest's arrival at all." Single
// static permission (booking:checkin) rather than the dynamic
// getMe()-derived pattern the work-order status endpoint uses — unlike
// that endpoint, check-in has exactly one possible permission
// regardless of which of the two allowed `from` statuses (PENDING/
// CONFIRMED) applies, so there's nothing to derive.
bookingsRouter.post(
  '/bookings/:id/checkin',
  requirePermission('booking:checkin'),
  asyncHandler(async (req, res) => {
    const body = checkInBookingSchema.parse(req.body);
    const booking = await checkInBooking(req.params.id as string, body, req.authUser!);
    res.status(200).json({ booking });
  }),
);

// "Build checkout as a simple, permanent status flip... unconditional."
bookingsRouter.post(
  '/bookings/:id/checkout',
  requirePermission('booking:checkout'),
  asyncHandler(async (req, res) => {
    const body = checkOutBookingSchema.parse(req.body);
    const booking = await checkOutBooking(req.params.id as string, body, req.authUser!);
    res.status(200).json({ booking });
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
