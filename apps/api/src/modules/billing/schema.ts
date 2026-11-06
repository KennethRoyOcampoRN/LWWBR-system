import { FOLIO_CHARGE_SOURCE_KEYS, PAYMENT_KIND_KEYS, PAYMENT_METHOD_KEYS, RECEIPT_DEDUCTION_TYPE_KEYS } from '@lwwbr/shared';
import { z } from 'zod';

// Build plan stage 3 (spec.md §13 decision 13, 2026-11-04): folio
// line-item CRUD, payment submission/verification, and receipt
// issuance — same zod style as every other module's schema.ts
// (geofenceInputSchema, createRemittanceRequestSchema).

// Cashier-tab plan, spec.md §13 decision 16 (2026-11-05): "the cost of
// the room/unit must be automatic based on what the system admin has
// setup" (client's own words) — a ROOM charge is priced server-side from
// UnitType.baseRate and the billed BookingUnit's own date range
// (service.ts's priceRoomCharge), never from client input. unitPrice and
// qty are both optional here (rather than the plain-required shape every
// other source still uses) specifically so the refinements below can
// tell "ROOM, correctly omitted" apart from "non-ROOM, missing" and
// reject each the right way: a client that still sends unitPrice/qty for
// ROOM gets an explicit 422, not a silent overwrite — silently ignoring
// it would hide a caller that's still doing the wrong thing.
export const postFolioChargeSchema = z
  .object({
    source: z.enum(FOLIO_CHARGE_SOURCE_KEYS),
    // For ROOM, this is the BookingUnit id being priced — required so
    // priceRoomCharge knows which assignment's date range/UnitType to
    // read. For every other source it stays what it always was: an
    // optional loose pointer back to whatever record the charge came
    // from (an FnbOrder, an AmenityRequest, ...).
    sourceId: z.string().min(1).optional(),
    description: z.string().trim().min(1).max(300),
    qty: z.number().int().positive().optional(),
    unitPrice: z.number().nonnegative().optional(),
    // Bug caught in review, 2026-11-06 (spec.md §13 decision 16): a
    // walk-up booking's BookingUnit never gets a checkout date from any
    // other source — checkInBooking never collects one, and
    // Booking.departureDate stays null for a walk-up forever (the
    // 2026-08-24 redesign's own deliberate choice) — so priceRoomCharge
    // had no date to price against and 422'd on every single walk-up
    // room, the one flow that already existed. Optional and ROOM-only
    // in practice (priceRoomCharge ignores it once a real date is
    // already resolvable); see that function's own comment for exactly
    // when this is actually required.
    checkOutDate: z.string().date().optional(),
  })
  .refine((data) => data.source !== 'ROOM' || data.unitPrice === undefined, {
    message: "Room charges are priced automatically from the unit type's rate — do not submit unitPrice.",
    path: ['unitPrice'],
  })
  .refine((data) => data.source !== 'ROOM' || data.qty === undefined, {
    message: 'Room charges compute their own night count automatically — do not submit qty.',
    path: ['qty'],
  })
  .refine((data) => data.source !== 'ROOM' || Boolean(data.sourceId), {
    message: 'sourceId (the BookingUnit assignment being billed) is required for ROOM charges.',
    path: ['sourceId'],
  })
  .refine((data) => data.source === 'ROOM' || data.unitPrice !== undefined, {
    message: 'unitPrice is required.',
    path: ['unitPrice'],
  });
export type PostFolioChargeInput = z.infer<typeof postFolioChargeSchema>;

export const voidFolioChargeSchema = z.object({
  voidReason: z.string().trim().min(1).max(500),
});
export type VoidFolioChargeInput = z.infer<typeof voidFolioChargeSchema>;

export const submitPaymentSchema = z.object({
  amount: z.number().positive(),
  method: z.enum(PAYMENT_METHOD_KEYS),
  referenceNo: z.string().trim().max(100).optional(),
  proofFileId: z.string().min(1).optional(),
  kind: z.enum(PAYMENT_KIND_KEYS),
});
export type SubmitPaymentInput = z.infer<typeof submitPaymentSchema>;

// Bidirectional, same shape as remittances' own
// changeRemittanceRequestStatusSchema — VERIFIED can revert to PENDING,
// REJECTED needs a reason the same way a void does.
export const changePaymentStatusSchema = z.object({
  toStatus: z.enum(['PENDING', 'VERIFIED', 'REJECTED']),
  rejectionReason: z.string().trim().max(500).optional(),
});
export type ChangePaymentStatusInput = z.infer<typeof changePaymentStatusSchema>;

const receiptDeductionInputSchema = z.object({
  type: z.enum(RECEIPT_DEDUCTION_TYPE_KEYS),
  label: z.string().trim().min(1).max(200),
  amount: z.number().positive(),
  sourcePaymentId: z.string().min(1).optional(),
});

// Shared by both the preview and the real issuance — a preview computes
// the exact same totals the real issue call would, from the exact same
// shape, so what the cashier sees before confirming is never a
// different calculation than what gets persisted.
//
// Cashier-tab plan, spec.md §13 decision 16 (2026-11-05): `lines` is gone
// — a client-submitted lines array (with its unread sourceChargeId) was
// the actual integrity gap this round fixes. Both previewReceipt and
// issueReceipt now build their lines themselves, server-side, from the
// booking's own non-voided FolioCharge rows (gatherReceiptLines in
// service.ts) — there is no remaining path, preview included, where a
// client can submit a lines array that affects what a receipt shows or
// totals. Deductions stay client-typed — nothing in the client's plan
// asked for discounts/downpayments to be automatic.
//
// Deliberately permissive here (blank preparedByName allowed) — build
// plan stage 4 (2026-11-04): the billing page's first preview call, made
// the moment a booking is opened for billing, exists only to fetch the
// resort header/guest block (there's no standalone "GET /bookings/:id" —
// see this module's own README entry). `issueReceiptSchema` below
// tightens this back to required for the real, money-moving call.
export const receiptDraftSchema = z.object({
  guestContactNo: z.string().trim().max(50).nullable().optional(),
  guestEmail: z.string().trim().max(200).nullable().optional(),
  checkInDate: z.string().datetime().nullable().optional(),
  checkOutDate: z.string().datetime().nullable().optional(),
  nightsOfStay: z.number().int().positive().nullable().optional(),
  preparedByName: z.string().trim().max(200).default(''),
  deductions: z.array(receiptDeductionInputSchema).default([]),
});
export type ReceiptDraftInput = z.infer<typeof receiptDraftSchema>;

export const issueReceiptSchema = receiptDraftSchema.extend({
  preparedByName: z.string().trim().min(1).max(200),
  // Cashier-typed — the {typed} in {typed}-{MMDDYYYY}-{NN}. Digits only
  // on the sample (e.g. "83887"), but not enforced as numeric here: a
  // pre-printed receipt booklet number is whatever's physically
  // printed on it, and this app has no reason to assume every resort's
  // booklet uses digits only.
  billingNumberTyped: z.string().trim().min(1).max(50),
  // See billing/service.ts's own issueReceipt comment: true skips the
  // soft duplicate-billing-number warning and issues anyway — the
  // cashier UI sets this only after the person confirms the warning
  // dialog, never as a default.
  confirmDuplicateBillingNumber: z.boolean().default(false),
});
export type IssueReceiptInput = z.infer<typeof issueReceiptSchema>;

// Same shape as voidFolioChargeSchema — a mistaken receipt is voided
// (status: VOIDED), never deleted, same append-only reasoning as
// FolioCharge's own POSTED/VOIDED (see Receipt's own schema.prisma
// comment for why it has no deletedAt).
export const voidReceiptSchema = z.object({
  voidReason: z.string().trim().min(1).max(500),
});
export type VoidReceiptInput = z.infer<typeof voidReceiptSchema>;
