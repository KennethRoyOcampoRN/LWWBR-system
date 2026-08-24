import { z } from 'zod';

// Redesign, 2026-08-24 (client decision, live-testing feedback): "this
// app's job is monitoring the resort's current, live state, not
// managing reservations... there is no scenario where a reservation
// needs to be created inside this app." createBookingSchema/
// bookingUnitInputSchema/searchBookingsQuerySchema are gone — every
// guest already carries a real booking ID from the resort's external
// booking website, so there is no "create a reservation" step and
// nothing left to search for ahead of arrival.
//
// Check-in now *creates* the Booking row directly, at the moment the
// guest is standing in front of the desk — deliberately just the four
// fields asked for: guest name, the external booking ID (free text,
// captured as-is — not generated here the way the old referenceNo was),
// a check-in date, and the room(s) being assigned. No pax, no rate, no
// departure date — none of that is collected anymore; see the Prisma
// schema's own comment on Booking for how those columns went nullable
// to match.
export const checkInBookingSchema = z.object({
  guestName: z.string().trim().min(1).max(200),
  // Free text on purpose — this captures whatever the external booking
  // website's own reference looks like, not a format this app controls
  // or validates. Deliberately not required to be unique: a group can
  // arrive in waves under the same external ID across more than one
  // check-in submission (client decision, 2026-08-24) — see
  // findOccupiedUnitsForReferenceNo in service.ts for how checkout
  // groups rooms back together by this string.
  externalBookingId: z.string().trim().min(1).max(200),
  checkInDate: z.string().date(),
  units: z.array(z.object({ unitId: z.string().min(1) })).min(1).max(10),
  // Spec §7.5: "A unit that simply isn't READY yet at check-in raises a
  // warning the front desk acknowledges rather than a hard block — real
  // check-ins happen while the room is still being finished." First
  // attempt omits this; the server responds 409 UNIT_NOT_READY if any
  // unit isn't READY, and the client resubmits with this set to true to
  // proceed anyway. OUT_OF_ORDER/BLOCKED/already-OCCUPIED units are
  // never overridable this way — hard blocks regardless.
  acknowledgeNotReady: z.boolean().optional().default(false),
  // CheckInRecord's own operational-detail columns (waiver, wristbands,
  // key deposit, ID presented) aren't part of the four fields the new
  // Check-in form asks for, but the table's columns are still NOT NULL —
  // these stay optional-with-defaults so a bare submit still satisfies
  // that constraint, exactly as the original check-in slice designed it.
  // Nothing currently sends them; kept so a future UI can populate them
  // without another backend change.
  waiverSigned: z.boolean().optional().default(false),
  wristbandsIssued: z.number().int().min(0).optional().default(0),
  keyDepositAmount: z.number().nonnegative().optional().default(0),
  vehiclePlate: z.string().trim().max(50).optional(),
  idPresented: z.boolean().optional().default(false),
  notes: z.string().trim().max(2000).optional(),
});
export type CheckInBookingInput = z.infer<typeof checkInBookingSchema>;

// "Build checkout as a simple, permanent status flip... unconditional —
// not gated on any payment-settlement check, now or later." No balance
// field anywhere in this schema, deliberately — see the client's own
// architectural note: payment lives entirely outside this system.
//
// Checklist checkout, redesign 2026-08-24: "show a checklist of all
// rooms tied to that same Booking ID... let the user check/uncheck any
// combination." `unitIds` is that checklist's result — every unit the
// front desk actually confirmed should check out right now, which can
// span more than one Booking row once a group's rooms were checked in
// across more than one submission under the same external ID. See
// checkOutUnits in service.ts.
export const checkOutBookingSchema = z.object({
  unitIds: z.array(z.string().min(1)).min(1).max(20),
  damagesNoted: z.string().trim().max(2000).optional(),
  depositRefunded: z.boolean().optional().default(false),
});
export type CheckOutBookingInput = z.infer<typeof checkOutBookingSchema>;

// Powers the checkout checklist itself — given the unit the front desk
// clicked "Check out" from, find every other currently-Occupied unit
// sharing that same booking's external ID, so the client can render the
// full checklist before the checkout call above is ever made.
export const bookingGroupQuerySchema = z.object({
  referenceNo: z.string().trim().min(1).max(200),
});
export type BookingGroupQuery = z.infer<typeof bookingGroupQuerySchema>;
