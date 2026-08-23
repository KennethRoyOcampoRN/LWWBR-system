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
