import { BOOKING_SOURCE_KEYS, BOOKING_TYPE_KEYS } from '@lwwbr/shared';
import { z } from 'zod';

const bookingUnitInputSchema = z.object({
  unitId: z.string().min(1),
  // Optional — service.ts auto-fills from the unit's UnitType (baseRate
  // for OVERNIGHT, dayTourRate falling back to baseRate for DAY_TOUR)
  // when omitted. Spec §8.3's Cashier form: "rate auto-filled from
  // UnitType and overridable" — this is the override.
  rate: z.number().nonnegative().optional(),
});

// Spec §7.5: OVERNIGHT resolves startAt/endAt from arrivalDate +
// booking.checkInTime and departureDate + booking.checkOutTime;
// DAY_TOUR is the fixed 9am-5pm block for a single date, so
// departureDate isn't collected from the client at all — it's always
// set equal to arrivalDate in the service layer, never asked for, so
// there's no way to submit a mismatched pair for a type that spec says
// has no such concept ("no slots, no evening block").
export const createBookingSchema = z
  .object({
    guestName: z.string().trim().min(1).max(200),
    guestPhone: z.string().trim().max(50).optional(),
    guestEmail: z.string().trim().email().max(200).optional(),
    source: z.enum(BOOKING_SOURCE_KEYS).default('WALK_IN'),
    type: z.enum(BOOKING_TYPE_KEYS),
    arrivalDate: z.string().date(),
    // Required for OVERNIGHT, rejected for DAY_TOUR — enforced by the
    // .refine()s below rather than a plain optional field, since which
    // one applies depends on `type`.
    departureDate: z.string().date().optional(),
    pax: z.number().int().min(1),
    childrenPax: z.number().int().min(0).default(0),
    units: z.array(bookingUnitInputSchema).min(1).max(10),
    notes: z.string().trim().max(2000).optional(),
  })
  .refine((data) => data.type !== 'OVERNIGHT' || Boolean(data.departureDate), {
    message: 'departureDate is required for an OVERNIGHT booking',
    path: ['departureDate'],
  })
  .refine((data) => data.type !== 'DAY_TOUR' || !data.departureDate, {
    message: 'departureDate is not used for a DAY_TOUR — it is always the same day as arrivalDate',
    path: ['departureDate'],
  })
  .refine((data) => !data.departureDate || data.departureDate > data.arrivalDate, {
    message: 'departureDate must be after arrivalDate',
    path: ['departureDate'],
  });

export type CreateBookingInput = z.infer<typeof createBookingSchema>;

// Urgent gap, 2026-08-23: "input an existing Booking ID... confirm
// arrival — no new date/payment fields needed, those already exist on
// the booking record from creation." Deliberately lightweight — every
// field here is optional with a default, so a bare `{}` completes a
// check-in. The CheckInRecord columns these map to (waiverSigned,
// wristbandsIssued, keyDepositAmount, idPresented) are NOT NULL in the
// schema, so the defaults exist to satisfy that constraint without ever
// forcing the front desk to fill them in under pressure — they can be
// captured later if the front desk wants the detail, never required to
// complete the actual check-in action.
export const checkInBookingSchema = z.object({
  // Spec §7.5: "A unit that simply isn't READY yet at check-in raises a
  // warning the front desk acknowledges rather than a hard block — real
  // check-ins happen while the room is still being finished." First
  // attempt omits this; the server responds 409 UNIT_NOT_READY if any
  // unit isn't READY, and the client resubmits with this set to true to
  // proceed anyway. OUT_OF_ORDER/BLOCKED/already-OCCUPIED units are
  // never overridable this way — hard blocks regardless.
  acknowledgeNotReady: z.boolean().optional().default(false),
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
export const checkOutBookingSchema = z.object({
  damagesNoted: z.string().trim().max(2000).optional(),
  depositRefunded: z.boolean().optional().default(false),
});
export type CheckOutBookingInput = z.infer<typeof checkOutBookingSchema>;

// Powers the "guest name lookup" half of the check-in flow — the other
// half is pasting a known booking id/referenceNo directly into
// GET /bookings/:id, which needs no query schema of its own.
export const searchBookingsQuerySchema = z.object({
  search: z.string().trim().min(1).max(200),
});
export type SearchBookingsQuery = z.infer<typeof searchBookingsQuerySchema>;
