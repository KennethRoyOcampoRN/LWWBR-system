import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { requirePermission } from '../auth/requirePermission.js';
import { bookingGroupQuerySchema, checkInBookingSchema, checkOutBookingSchema } from './schema.js';
import { checkInBooking, checkOutUnits, findOccupiedUnitsForReferenceNo, listUpcomingBookingsForUnit } from './service.js';

export const bookingsRouter = Router();

// Redesign, 2026-08-24 (client decision, live-testing feedback): "this
// app's job is monitoring the resort's current, live state, not
// managing reservations." POST /bookings (creation), GET /bookings
// (search), and GET /bookings/:id are gone — every guest already has a
// real booking on the resort's external booking website before
// arriving, so there's no reservation to create ahead of time and
// nothing to search for before it exists in this app. Check-in below is
// now the only way a Booking row ever gets created.
bookingsRouter.post(
  '/bookings/checkin',
  requirePermission('booking:checkin'),
  asyncHandler(async (req, res) => {
    const body = checkInBookingSchema.parse(req.body);
    const booking = await checkInBooking(body, req.authUser!);
    res.status(201).json({ booking });
  }),
);

// Checklist checkout, redesign 2026-08-24: "show a checklist of all
// rooms tied to that same Booking ID... let the user check/uncheck any
// combination." This endpoint builds that checklist — every unit
// currently Occupied under a CHECKED_IN booking sharing `referenceNo`,
// which the client pre-checks the unit it was opened from and lets the
// front desk adjust before calling POST /bookings/checkout.
bookingsRouter.get(
  '/bookings/group',
  requirePermission('booking:checkout'),
  asyncHandler(async (req, res) => {
    const query = bookingGroupQuerySchema.parse(req.query);
    const units = await findOccupiedUnitsForReferenceNo(query.referenceNo);
    res.status(200).json({ units });
  }),
);

// "Build checkout as a simple, permanent status flip... unconditional."
// `unitIds` is the confirmed checklist result — see checkOutUnits's own
// comment in service.ts for how a checkout call can finalize more than
// one Booking row at once (a group checked in across waves under one
// external ID) while leaving a partially-cleared row at CHECKED_IN.
bookingsRouter.post(
  '/bookings/checkout',
  requirePermission('booking:checkout'),
  asyncHandler(async (req, res) => {
    const body = checkOutBookingSchema.parse(req.body);
    const result = await checkOutUnits(body.unitIds, body, req.authUser!);
    res.status(200).json(result);
  }),
);

// Gated on unit:read, not a booking permission — this is fundamentally
// "does this unit have a reservation," the same kind of unit-level fact
// the units module's own /units/:id/timeline already answers. A Room
// Attendant (HOUSEKEEPING_STAFF) who holds unit:read but never
// booking:checkin/booking:checkout still needs to see this — real gap
// found live-testing: "a cashier or housekeeper looking at the Units
// page has no way to know a room has an upcoming booking at all." Lives
// on the bookings router (not units/router.ts) since it queries
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
