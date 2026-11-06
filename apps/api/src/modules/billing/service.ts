import { TZDate } from '@date-fns/tz';
import { Prisma } from '@prisma/client';
import { BOOKING_STATUSES_EXCLUDED_FROM_AVAILABILITY, type ReceiptDeductionTypeKey } from '@lwwbr/shared';
import { getStorageAdapter } from '../../adapters/storage/index.js';
import { ApiError } from '../../lib/apiError.js';
import { roundMoney, sumMoney } from '../../lib/money.js';
import { prisma } from '../../lib/prisma.js';
import { billingNumberScope, formatBillingNumber } from '../../lib/receiptNo.js';
import { listUnsettledChargeToRoomOrders } from '../fnb/service.js';
import { getResortIdentityForSnapshot } from '../settings/service.js';
import type {
  ChangePaymentStatusInput,
  IssueReceiptInput,
  PostFolioChargeInput,
  ReceiptDraftInput,
  SubmitPaymentInput,
  VoidFolioChargeInput,
  VoidReceiptInput,
} from './schema.js';

interface BillingActor {
  id: string;
}

async function requireBooking(bookingId: string) {
  const booking = await prisma.booking.findFirst({ where: { id: bookingId, deletedAt: null } });
  if (!booking) {
    throw new ApiError(404, 'NOT_FOUND', 'Booking not found');
  }
  return booking;
}

// Cashier-tab plan (spec.md §13.4, 2026-11-05): given the entry-point
// booking a bill was opened from, find every Booking row sharing its
// referenceNo that's still "current" (not CANCELLED/CHECKED_OUT) —
// reusing BOOKING_STATUSES_EXCLUDED_FROM_AVAILABILITY, the exact
// constant findOccupiedUnitsForReferenceNo in bookings/service.ts
// already uses for the checkout checklist, rather than inventing a
// second definition of "still active." referenceNo is not unique (a
// group can check in across more than one submission under the same
// external ID, each its own Booking row) — this is what makes the F&B
// pull-in correct for such a group instead of reproducing the exact
// keying bug the client caught in the receipt model itself.
async function gatherBookingIdsForBilling(entryBooking: { id: string; referenceNo: string }): Promise<string[]> {
  const siblings = await prisma.booking.findMany({
    where: {
      referenceNo: entryBooking.referenceNo,
      deletedAt: null,
      status: { notIn: [...BOOKING_STATUSES_EXCLUDED_FROM_AVAILABILITY] },
    },
    select: { id: true },
  });
  const ids = new Set(siblings.map((b) => b.id));
  ids.add(entryBooking.id); // always include the entry point, even if its own status is excluded
  return [...ids];
}

// Cashier-tab plan (spec.md §13.4, Stage B, 2026-11-05): the F&B
// pull-in's read side — gathers unsettled charge-to-room orders across
// every Booking row sharing the entry booking's external ID, not just
// the entry-point row itself.
export async function listUnsettledFnbCharges(bookingId: string) {
  const booking = await requireBooking(bookingId);
  const bookingIds = await gatherBookingIdsForBilling(booking);
  return listUnsettledChargeToRoomOrders(bookingIds);
}

// ————————————————————————————————————————————————————————————
// Folio charges
// ————————————————————————————————————————————————————————————

function folioChargeToJson<T extends { unitPrice: unknown; amount: unknown }>(charge: T) {
  return { ...charge, unitPrice: Number(charge.unitPrice), amount: Number(charge.amount) };
}

// Corrected 2026-11-05, same review that caught the issueReceipt/
// previewReceipt sibling-gathering requirement: this used to scope to
// the single entry-point bookingId only, while gatherReceiptLines (what
// issueReceipt/previewReceipt actually bill) and listUnsettledFnbCharges
// above both gather every Booking row sharing the entry booking's
// referenceNo. A cashier viewing this folio for a multi-booking group
// would see an incomplete bill right up until issuing, where the total
// would suddenly include charges never shown on screen — the same
// wrong-attribution failure mode this whole decision has been chasing,
// just surfacing as "the system charged more than it showed me" instead
// of a misattributed charge.
export async function listFolioCharges(bookingId: string) {
  const booking = await requireBooking(bookingId);
  const bookingIds = await gatherBookingIdsForBilling(booking);
  const charges = await prisma.folioCharge.findMany({
    where: { bookingId: { in: bookingIds }, deletedAt: null },
    orderBy: { createdAt: 'asc' },
  });
  return charges.map(folioChargeToJson);
}

const MS_PER_NIGHT = 24 * 60 * 60 * 1000;

// Same Asia/Manila-midnight parsing as bookings/service.ts's own
// resolveManilaDate — spec §3.2: "Timezone Asia/Manila everywhere...
// never store naive local time." Duplicated locally rather than
// imported: that helper isn't exported, and this module's one caller
// (the checkOutDate fallback below) doesn't justify promoting it to a
// shared lib location on its own.
const RESORT_TIMEZONE = 'Asia/Manila';
function resolveManilaDate(dateStr: string): Date {
  const [year, month, day] = dateStr.split('-').map(Number) as [number, number, number];
  return new TZDate(year, month - 1, day, 0, 0, RESORT_TIMEZONE);
}

// Cashier-tab plan, spec.md §13 decision 16 (2026-11-05): "the cost of
// the room/unit must be automatic based on what the system admin has
// setup" (client's own words). sourceId for a ROOM charge is the
// BookingUnit assignment being billed — its own occupiedFrom/occupiedTo
// gives the night count, and its Unit's UnitType.baseRate gives the
// per-night price. Rate RULES (seasonal/day-of-week pricing) are future
// work per the plan's own parenthetical — baseRate is the whole story
// for now.
//
// Bug caught in review, 2026-11-06: this used to require
// bookingUnit.occupiedFrom outright and 422 if it was null — which it
// always is for a walk-up booking, since checkInBooking creates
// BookingUnit rows as bare { unitId } with no dates at all. Every
// walk-up booking (the one flow that already existed before decision
// 16) was therefore permanently unbillable. Fixed with the same
// null-or-fallback shape the end date already used: occupiedFrom falls
// back to booking.arrivalDate, which checkInBookingSchema's own
// required checkInDate guarantees is never null for any booking,
// walk-up or pre-arrival. The end date has no such guaranteed fallback
// — Booking.departureDate stays null for a walk-up forever (2026-08-24
// redesign's own deliberate choice) — so when neither occupiedTo nor
// departureDate resolves it, the cashier is asked for one explicitly
// (checkOutDate, postFolioChargeSchema) rather than silently guessing.
// Once resolved from any source, both dates are written back onto the
// BookingUnit row so a later reprice (or Stage D's per-night rate
// resolution) never has to ask again — this is the same row a pre-
// arrival booking already has these fields on from creation; a
// walk-up's just gets filled in lazily, at the moment billing actually
// needs it, which is the only moment this app ever learns it.
async function priceRoomCharge(
  bookingId: string,
  bookingUnitId: string,
  cashierCheckOutDate?: string,
): Promise<{ unitPrice: number; qty: number }> {
  const bookingUnit = await prisma.bookingUnit.findFirst({
    where: { id: bookingUnitId, bookingId, deletedAt: null },
    include: { unit: { include: { unitType: true } }, booking: true },
  });
  if (!bookingUnit) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'sourceId must be an existing room assignment on this booking.');
  }

  const from = bookingUnit.occupiedFrom ?? bookingUnit.booking.arrivalDate;

  let to = bookingUnit.occupiedTo ?? bookingUnit.booking.departureDate;
  if (!to && cashierCheckOutDate) {
    to = resolveManilaDate(cashierCheckOutDate);
  }
  if (!to) {
    throw new ApiError(
      422,
      'ROOM_CHECKOUT_DATE_REQUIRED',
      'This room has no checkout date on file (a walk-up booking never collects one) — supply one to price this charge.',
    );
  }

  const nights = Math.round((to.getTime() - from.getTime()) / MS_PER_NIGHT);
  if (nights <= 0) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Check-out must be after check-in to price a room charge.');
  }

  if (!bookingUnit.occupiedFrom || !bookingUnit.occupiedTo) {
    await prisma.bookingUnit.update({ where: { id: bookingUnit.id }, data: { occupiedFrom: from, occupiedTo: to } });
  }

  return { unitPrice: Number(bookingUnit.unit.unitType.baseRate), qty: nights };
}

// unitPrice/qty are cashier input for every source except ROOM — see
// postFolioChargeSchema's own refinements for why ROOM rejects both
// outright instead of silently overwriting them. amount is always
// qty*unitPrice computed here, server-side, never trusted from the
// client — same reconciliation principle the receipt totals below are
// built on.
export async function postFolioCharge(bookingId: string, input: PostFolioChargeInput, actor: BillingActor) {
  await requireBooking(bookingId);

  let qty: number;
  let unitPrice: number;
  if (input.source === 'ROOM') {
    // input.sourceId's presence is already guaranteed by the schema's
    // own refinement; this check exists only because that refinement
    // doesn't narrow PostFolioChargeInput's type for TypeScript.
    if (!input.sourceId) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'sourceId is required for ROOM charges.');
    }
    const priced = await priceRoomCharge(bookingId, input.sourceId, input.checkOutDate);
    qty = priced.qty;
    unitPrice = priced.unitPrice;
  } else {
    if (input.unitPrice === undefined) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'unitPrice is required.');
    }
    qty = input.qty ?? 1;
    unitPrice = input.unitPrice;
  }

  const charge = await prisma.folioCharge.create({
    data: {
      bookingId,
      source: input.source,
      sourceId: input.sourceId,
      description: input.description,
      qty,
      unitPrice,
      amount: roundMoney(qty * unitPrice),
      postedById: actor.id,
      postedAt: new Date(),
    },
  });
  return folioChargeToJson(charge);
}

export async function voidFolioCharge(id: string, input: VoidFolioChargeInput, actor: BillingActor) {
  const existing = await prisma.folioCharge.findFirst({ where: { id, deletedAt: null } });
  if (!existing) {
    throw new ApiError(404, 'NOT_FOUND', 'Folio charge not found');
  }
  if (existing.status === 'VOIDED') {
    throw new ApiError(409, 'ALREADY_VOIDED', 'This charge is already voided.');
  }
  const charge = await prisma.folioCharge.update({
    where: { id },
    data: { status: 'VOIDED', voidedById: actor.id, voidedAt: new Date(), voidReason: input.voidReason },
  });
  return folioChargeToJson(charge);
}

// ————————————————————————————————————————————————————————————
// Payments
// ————————————————————————————————————————————————————————————

function paymentToJson<T extends { amount: unknown }>(payment: T) {
  return { ...payment, amount: Number(payment.amount) };
}

export async function listPayments(bookingId: string) {
  const payments = await prisma.payment.findMany({
    where: { bookingId, deletedAt: null },
    orderBy: { createdAt: 'asc' },
  });
  return payments.map(paymentToJson);
}

export async function submitPayment(bookingId: string, input: SubmitPaymentInput, actor: BillingActor) {
  await requireBooking(bookingId);
  const payment = await prisma.payment.create({
    data: {
      bookingId,
      amount: input.amount,
      method: input.method,
      referenceNo: input.referenceNo,
      proofFileId: input.proofFileId,
      kind: input.kind,
      submittedById: actor.id,
      submittedAt: new Date(),
    },
  });
  return paymentToJson(payment);
}

// Bidirectional, same shape as remittances' own
// changeRemittanceRequestStatus — VERIFIED can revert to PENDING.
export async function changePaymentStatus(id: string, input: ChangePaymentStatusInput, actor: BillingActor) {
  const existing = await prisma.payment.findFirst({ where: { id, deletedAt: null } });
  if (!existing) {
    throw new ApiError(404, 'NOT_FOUND', 'Payment not found');
  }

  const data: Prisma.PaymentUncheckedUpdateInput = { status: input.toStatus };
  if (input.toStatus === 'REJECTED') {
    if (!input.rejectionReason) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'A rejection reason is required to reject a payment.');
    }
    data.rejectionReason = input.rejectionReason;
    data.verifiedById = actor.id;
    data.verifiedAt = new Date();
  } else if (input.toStatus === 'VERIFIED') {
    data.rejectionReason = null;
    data.verifiedById = actor.id;
    data.verifiedAt = new Date();
  } else {
    data.rejectionReason = null;
    data.verifiedById = null;
    data.verifiedAt = null;
  }

  const payment = await prisma.payment.update({ where: { id }, data });
  return paymentToJson(payment);
}

// ————————————————————————————————————————————————————————————
// Receipts
// ————————————————————————————————————————————————————————————

interface ComputedReceiptLine {
  description: string;
  qty: number;
  unitPrice: number;
  amount: number;
  sourceChargeId: string | null;
}

interface ComputedReceiptDeduction {
  type: ReceiptDeductionTypeKey;
  label: string;
  amount: number;
  sourcePaymentId: string | null;
}

interface ComputedReceiptTotals {
  lines: ComputedReceiptLine[];
  deductions: ComputedReceiptDeduction[];
  grandTotal: number;
  totalDeductions: number;
  totalAmountDue: number;
}

// Cashier-tab plan, spec.md §13 decision 16 (2026-11-05): the real
// running folio — "if the cashier or resto would like to bill a room...
// a bill [is] based on the BOOKING number" (client's own words). Both
// previewReceipt and issueReceipt call this, so a preview can never
// price differently than issuance: every non-voided FolioCharge across
// every Booking row sharing the entry booking's referenceNo
// (gatherBookingIdsForBilling — the same grouping the F&B pull-in
// already uses), full stop. Nothing closes the folio at issuance, so
// this always returns the complete current set, not just what's new
// since the last receipt — a later charge just appears on the next
// receipt's own full total, which is what makes each issued Receipt a
// true snapshot of the folio's state at that moment rather than an
// incremental invoice. `amount` is recomputed from qty*unitPrice here
// rather than trusted from the already-persisted FolioCharge.amount, same
// never-trust-a-stored-total posture as everything else in this file.
async function gatherReceiptLines(entryBooking: { id: string; referenceNo: string }): Promise<ComputedReceiptLine[]> {
  const bookingIds = await gatherBookingIdsForBilling(entryBooking);
  const charges = await prisma.folioCharge.findMany({
    where: { bookingId: { in: bookingIds }, status: 'POSTED', deletedAt: null },
    orderBy: { postedAt: 'asc' },
  });
  return charges.map((charge) => {
    const qty = charge.qty;
    const unitPrice = Number(charge.unitPrice);
    return {
      description: charge.description,
      qty,
      unitPrice,
      amount: roundMoney(qty * unitPrice),
      sourceChargeId: charge.id,
    };
  });
}

// The one place a receipt's totals are computed — grandTotal and
// totalAmountDue are never independent inputs, so a receipt can't be
// persisted with totals that don't reconcile with its own lines: there
// is no code path that accepts a client-submitted total, or a
// client-submitted line, at all — `lines` comes from gatherReceiptLines
// above, never from `input`. `amount` per deduction is the submitted
// amount rounded to the cent, never trusted as-is beyond that rounding.
function computeReceiptTotals(lines: ComputedReceiptLine[], input: ReceiptDraftInput): ComputedReceiptTotals {
  const deductions: ComputedReceiptDeduction[] = input.deductions.map((deduction) => ({
    type: deduction.type,
    label: deduction.label,
    amount: roundMoney(deduction.amount),
    sourcePaymentId: deduction.sourcePaymentId ?? null,
  }));

  const grandTotal = sumMoney(lines.map((line) => line.amount));
  const totalDeductions = sumMoney(deductions.map((deduction) => deduction.amount));
  const totalAmountDue = roundMoney(grandTotal - totalDeductions);

  // totalAmountDue is derived by construction — grandTotal minus
  // totalDeductions, computed right above, with no other code path able
  // to set either value — so there's no independent "does this
  // reconcile" fact to assert here; a check written against the same
  // expression that produced the value can only ever repeat it. The
  // real reconciliation guard that can actually fail lives in
  // issueReceipt, after the created rows come back from Postgres: it
  // recomputes from what was actually persisted (post-Decimal-column
  // round trip), not from these pre-insert numbers.
  //
  // What this function does guard, explicitly: deductions must not
  // exceed the grand total. Nothing capped totalDeductions against
  // grandTotal above, so a mistyped downpayment could otherwise yield a
  // receipt with a negative Total Amount Due — client decision,
  // 2026-11-04: reject outright rather than silently persist a negative
  // amount due. A genuine refund-due case (deductions exceeding what
  // was charged) is a materially different document from an
  // acknowledgement receipt — it would need its own printed label and
  // rendering, not a negative number in the same Total Amount Due field
  // this receipt type prints — so it's out of scope here, not silently
  // allowed through.
  if (totalAmountDue < 0) {
    throw new ApiError(
      422,
      'DEDUCTIONS_EXCEED_GRAND_TOTAL',
      `Deductions total ₱${totalDeductions.toFixed(2)}, which exceeds the grand total of ₱${grandTotal.toFixed(2)} by ₱${Math.abs(totalAmountDue).toFixed(2)}. Adjust the deduction amount(s) before issuing.`,
    );
  }

  return { lines, deductions, grandTotal, totalDeductions, totalAmountDue };
}

async function logoSnapshotToJson(logoFileId: string | null) {
  if (!logoFileId) return null;
  const file = await prisma.fileObject.findFirst({ where: { id: logoFileId, deletedAt: null } });
  if (!file) return null;
  return {
    id: file.id,
    filename: file.filename,
    mimeType: file.mimeType,
    url: await getStorageAdapter().getSignedUrl(file.storageKey),
  };
}

export async function previewReceipt(bookingId: string, input: ReceiptDraftInput) {
  const booking = await requireBooking(bookingId);
  const resortIdentity = await getResortIdentityForSnapshot();
  const lines = await gatherReceiptLines(booking);
  const totals = computeReceiptTotals(lines, input);

  return {
    resort: {
      name: resortIdentity.name,
      address: resortIdentity.address,
      cellNo: resortIdentity.cellNo,
      contactNo: resortIdentity.contactNo,
      website: resortIdentity.website,
      facebookUrl: resortIdentity.facebookUrl,
      logo: await logoSnapshotToJson(resortIdentity.logoFileId),
    },
    guest: {
      name: booking.guestName,
      address: booking.guestAddress,
      contactNo: input.guestContactNo ?? booking.guestPhone,
      email: input.guestEmail ?? booking.guestEmail,
    },
    lines: totals.lines,
    deductions: totals.deductions,
    grandTotal: totals.grandTotal,
    totalDeductions: totals.totalDeductions,
    totalAmountDue: totals.totalAmountDue,
  };
}

type RawReceiptWithChildren = {
  grandTotal: unknown;
  totalAmountDue: unknown;
  logoFileId: string | null;
  lines: { unitPrice: unknown; amount: unknown; [key: string]: unknown }[];
  deductions: { amount: unknown; [key: string]: unknown }[];
  [key: string]: unknown;
};

async function receiptToJson(receipt: RawReceiptWithChildren) {
  const { lines, deductions, logoFileId, grandTotal, totalAmountDue, ...rest } = receipt;
  return {
    ...rest,
    logo: await logoSnapshotToJson(logoFileId),
    grandTotal: Number(grandTotal),
    totalAmountDue: Number(totalAmountDue),
    lines: lines.map((line) => ({ ...line, unitPrice: Number(line.unitPrice), amount: Number(line.amount) })),
    deductions: deductions.map((deduction) => ({ ...deduction, amount: Number(deduction.amount) })),
  };
}

// The real reconciliation guard — unlike the removed check that used
// to live in computeReceiptTotals (which compared an expression against
// itself and could never fail), this recomputes from the rows exactly
// as they come back out of `receiptToJson`: after the round trip
// through Postgres's NUMERIC(12,2) columns and Prisma's Decimal
// conversion, not from the pre-insert numbers that went in. A
// serialization or rounding fault introduced anywhere in that path —
// not just a logic bug in computeReceiptTotals — would show up here.
// Same recomputation the test suite's own reconciliation test performs
// independently against the rows passed to `prisma.receipt.create`.
function assertReceiptReconciles(json: {
  grandTotal: number;
  totalAmountDue: number;
  lines: { amount: number }[];
  deductions: { amount: number }[];
}): void {
  const lineSum = sumMoney(json.lines.map((line) => line.amount));
  const deductionSum = sumMoney(json.deductions.map((deduction) => deduction.amount));
  if (lineSum !== json.grandTotal || roundMoney(lineSum - deductionSum) !== json.totalAmountDue) {
    throw new ApiError(
      500,
      'TOTALS_DO_NOT_RECONCILE',
      'Internal error: the persisted receipt totals do not reconcile with its own lines and deductions.',
    );
  }
}

const RECEIPT_INCLUDE = { lines: true, deductions: true } as const;

// Defense in depth, not the primary safeguard: the atomic
// ReferenceSequence upsert (same mechanism referenceNo.ts's
// generateReferenceNo already relies on) means two concurrent issuances
// for the same {typed, date} scope always get distinct seq values —
// this P2002 branch exists for the gap that leaves open regardless (a
// retry after a crash between the two statements, or anything else
// that could reuse an already-committed {scope, seq} pair), so a
// cashier never sees a raw Prisma constraint-violation error: it's
// caught here and the whole allocate+insert pair is retried inside a
// fresh transaction, which re-reads the now-current ReferenceSequence
// row and gets a new seq.
function isUniqueConstraintViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

const MAX_BILLING_NUMBER_ATTEMPTS = 5;

// Corrected 2026-11-05 (spec.md §13.4) — the client caught a design
// error here: this used to compare bookingId, which warns on every
// second room of a legitimate group checked in across more than one
// submission under the same external ID (referenceNo isn't unique —
// see gatherBookingIdsForBilling's own comment). The scope is
// deliberately NOT globally unique — the same cashier-typed number can
// legitimately recur across days, or collide within a day if mistyped
// — so this checks whether an existing receipt under the same scope
// belongs to a *different external booking*; if so, it's a soft warn
// (409 DUPLICATE_BILLING_NUMBER) the caller can bypass by resubmitting
// with confirmDuplicateBillingNumber: true. A same-external-booking
// match (an ordinary reissue, or another room under the same group) now
// correctly never triggers this.
//
// The `OR` with an explicit `externalBookingRef: null` branch is
// deliberate, not redundant with the `not` filter — pinned empirically
// against a real Postgres (spec.md §13.4's own note), not assumed:
// Prisma compiles `{ not: value }` on a nullable column to plain SQL
// `<>`, not `IS DISTINCT FROM`, so a legacy receipt with no
// externalBookingRef yet (pre-backfill) would match neither side of
// that comparison and be invisible to collision detection entirely. An
// unknown (null) row is treated as "flag it," matching how a financial
// collision check should err — toward a false-positive warning a
// cashier clicks through once, never toward silently missing a real
// collision.
async function isDuplicateBillingNumber(scope: string, externalBookingRef: string): Promise<boolean> {
  const collision = await prisma.receipt.findFirst({
    where: {
      billingNumberScope: scope,
      OR: [{ externalBookingRef: { not: externalBookingRef } }, { externalBookingRef: null }],
    },
  });
  return collision !== null;
}

// Client-confirmed design (spec.md §13 decision 13 build plan, gap 4):
// the {typed}-{MMDDYYYY} scope is deliberately NOT globally unique — the
// same cashier-typed number can legitimately recur across days, or
// collide within a day if mistyped. Before issuing, this checks whether
// an existing receipt under the same scope belongs to a *different*
// booking; if so, it's a soft warn (409 DUPLICATE_BILLING_NUMBER) the
// caller can bypass by resubmitting with confirmDuplicateBillingNumber:
// true (set only after the cashier confirms a warning dialog) — a
// same-booking match (an ordinary reissue) never triggers this at all.
export async function issueReceipt(bookingId: string, input: IssueReceiptInput, actor: BillingActor) {
  const booking = await requireBooking(bookingId);
  const resortIdentity = await getResortIdentityForSnapshot();
  const lines = await gatherReceiptLines(booking);
  if (lines.length === 0) {
    throw new ApiError(422, 'NO_CHARGES', 'This folio has no posted charges yet — nothing to issue a receipt for.');
  }
  const totals = computeReceiptTotals(lines, input);
  const scope = billingNumberScope(input.billingNumberTyped);

  // Prefer validation over warning (spec.md §13.4, client decision,
  // 2026-11-05): the billing number's typed base is the external
  // booking ID, and checkInBookingSchema guarantees booking.referenceNo
  // is never blank — a mismatch here is always a cashier mistype, not a
  // legitimate case, so it's rejected outright rather than folded into
  // the soft duplicate-warn below.
  if (input.billingNumberTyped !== booking.referenceNo) {
    throw new ApiError(
      422,
      'BILLING_NUMBER_MISMATCH',
      `The billing number "${input.billingNumberTyped}" does not match this booking's own external ID ("${booking.referenceNo}").`,
    );
  }

  if (!input.confirmDuplicateBillingNumber) {
    if (await isDuplicateBillingNumber(scope, booking.referenceNo)) {
      throw new ApiError(
        409,
        'DUPLICATE_BILLING_NUMBER',
        'This billing number was already used today for a different booking. Confirm to issue it anyway.',
      );
    }
  }

  for (let attempt = 1; attempt <= MAX_BILLING_NUMBER_ATTEMPTS; attempt++) {
    try {
      // Allocating the sequence and inserting the Receipt in the same
      // transaction means a failed insert (including the P2002 this
      // function retries on) rolls the sequence increment back too —
      // a retry re-reads the pre-attempt ReferenceSequence row rather
      // than burning a number the failed attempt never actually used.
      const receipt = await prisma.$transaction(async (tx) => {
        const { seq } = await tx.referenceSequence.upsert({
          where: { scope },
          update: { seq: { increment: 1 } },
          create: { scope, seq: 1 },
        });
        const created = await tx.receipt.create({
          data: {
            bookingId,
            externalBookingRef: booking.referenceNo,
            billingNumberScope: scope,
            billingSeq: seq,
            billingNumberFull: formatBillingNumber(scope, seq),
            resortName: resortIdentity.name,
            resortAddress: resortIdentity.address,
            resortCellNo: resortIdentity.cellNo,
            resortContactNo: resortIdentity.contactNo,
            resortWebsite: resortIdentity.website,
            resortFacebook: resortIdentity.facebookUrl,
            logoFileId: resortIdentity.logoFileId,
            guestName: booking.guestName,
            guestAddress: booking.guestAddress,
            guestContactNo: input.guestContactNo ?? booking.guestPhone ?? null,
            guestEmail: input.guestEmail ?? booking.guestEmail ?? null,
            checkInDate: input.checkInDate ? new Date(input.checkInDate) : null,
            checkOutDate: input.checkOutDate ? new Date(input.checkOutDate) : null,
            nightsOfStay: input.nightsOfStay ?? null,
            grandTotal: totals.grandTotal,
            totalAmountDue: totals.totalAmountDue,
            issuedById: actor.id,
            issuedAt: new Date(),
            preparedByName: input.preparedByName,
            lines: { create: totals.lines },
            deductions: { create: totals.deductions },
          },
          include: RECEIPT_INCLUDE,
        });
        // One ReceiptBooking row for the entry-point booking — this
        // stage doesn't yet gather and bill a sibling booking's own
        // room lines (that's Stage D, combined with rate rules' own
        // per-night stage per spec.md §13.3/§13.4); a sibling's F&B
        // charges pulled in via the existing postFolioCharge flow
        // already attach to THIS booking's folio regardless of which
        // Booking row the source FnbOrder itself belongs to, so no
        // second ReceiptBooking row is needed for that case either.
        await tx.receiptBooking.create({ data: { receiptId: created.id, bookingId } });
        return created;
      });
      const json = await receiptToJson(receipt);
      assertReceiptReconciles(json);
      return json;
    } catch (err) {
      if (isUniqueConstraintViolation(err) && attempt < MAX_BILLING_NUMBER_ATTEMPTS) {
        continue;
      }
      if (isUniqueConstraintViolation(err)) {
        throw new ApiError(
          409,
          'BILLING_NUMBER_ALLOCATION_FAILED',
          'Could not allocate a unique billing number after multiple attempts. Please try again.',
        );
      }
      throw err;
    }
  }

  // Unreachable — the loop above always returns or throws — but TypeScript
  // can't see that from a try/catch inside a for loop, so this satisfies
  // the "function must return" check without an `as never` cast.
  throw new ApiError(500, 'UNREACHABLE', 'issueReceipt fell through its retry loop unexpectedly.');
}

// Queries ReceiptBooking, not Receipt.bookingId directly (corrected
// 2026-11-05, spec.md §13.4) — a receipt issued from a different room's
// entry point can still have covered this booking (a group checked in
// across more than one submission under the same external ID), and
// this must show up here too, not just in the entry-point room's own
// history.
export async function listReceiptsForBooking(bookingId: string) {
  const coverage = await prisma.receiptBooking.findMany({
    where: { bookingId },
    include: { receipt: { include: RECEIPT_INCLUDE } },
    orderBy: { receipt: { issuedAt: 'desc' } },
  });
  return Promise.all(coverage.map((c) => receiptToJson(c.receipt)));
}

export async function getReceipt(id: string) {
  const receipt = await prisma.receipt.findFirst({ where: { id }, include: RECEIPT_INCLUDE });
  if (!receipt) {
    throw new ApiError(404, 'NOT_FOUND', 'Receipt not found');
  }
  return receiptToJson(receipt);
}

export async function voidReceipt(id: string, input: VoidReceiptInput, actor: BillingActor) {
  const existing = await prisma.receipt.findFirst({ where: { id } });
  if (!existing) {
    throw new ApiError(404, 'NOT_FOUND', 'Receipt not found');
  }
  if (existing.status === 'VOIDED') {
    throw new ApiError(409, 'ALREADY_VOIDED', 'This receipt is already voided.');
  }
  const receipt = await prisma.receipt.update({
    where: { id },
    data: { status: 'VOIDED', voidedById: actor.id, voidedAt: new Date(), voidReason: input.voidReason },
    include: RECEIPT_INCLUDE,
  });
  return receiptToJson(receipt);
}
