import { Prisma } from '@prisma/client';
import type { ReceiptDeductionTypeKey } from '@lwwbr/shared';
import { getStorageAdapter } from '../../adapters/storage/index.js';
import { ApiError } from '../../lib/apiError.js';
import { roundMoney, sumMoney } from '../../lib/money.js';
import { prisma } from '../../lib/prisma.js';
import { billingNumberScope, formatBillingNumber } from '../../lib/receiptNo.js';
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

// ————————————————————————————————————————————————————————————
// Folio charges
// ————————————————————————————————————————————————————————————

function folioChargeToJson<T extends { unitPrice: unknown; amount: unknown }>(charge: T) {
  return { ...charge, unitPrice: Number(charge.unitPrice), amount: Number(charge.amount) };
}

export async function listFolioCharges(bookingId: string) {
  const charges = await prisma.folioCharge.findMany({
    where: { bookingId, deletedAt: null },
    orderBy: { createdAt: 'asc' },
  });
  return charges.map(folioChargeToJson);
}

// unitPrice is cashier input (e.g. read off UnitType.baseRate/dayTourRate/
// extraPersonRate client-side); amount is always qty*unitPrice computed
// here, server-side, never trusted from the client — same reconciliation
// principle the receipt totals below are built on.
export async function postFolioCharge(bookingId: string, input: PostFolioChargeInput, actor: BillingActor) {
  await requireBooking(bookingId);
  const charge = await prisma.folioCharge.create({
    data: {
      bookingId,
      source: input.source,
      sourceId: input.sourceId,
      description: input.description,
      qty: input.qty,
      unitPrice: input.unitPrice,
      amount: roundMoney(input.qty * input.unitPrice),
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

// The one place a receipt's totals are computed — grandTotal and
// totalAmountDue are never independent inputs, so a receipt can't be
// persisted with totals that don't reconcile with its own lines: there
// is no code path that accepts a client-submitted total at all.
// `amount` per line/deduction is likewise always qty*unitPrice (lines)
// or the submitted amount rounded to the cent (deductions), never a
// client-submitted amount trusted as-is for lines.
function computeReceiptTotals(input: ReceiptDraftInput): ComputedReceiptTotals {
  const lines: ComputedReceiptLine[] = input.lines.map((line) => ({
    description: line.description,
    qty: line.qty,
    unitPrice: line.unitPrice,
    amount: roundMoney(line.qty * line.unitPrice),
    sourceChargeId: line.sourceChargeId ?? null,
  }));
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
  const totals = computeReceiptTotals(input);

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
  const totals = computeReceiptTotals(input);
  const scope = billingNumberScope(input.billingNumberTyped);

  if (!input.confirmDuplicateBillingNumber) {
    const collision = await prisma.receipt.findFirst({
      where: { billingNumberScope: scope, bookingId: { not: bookingId } },
    });
    if (collision) {
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
        return tx.receipt.create({
          data: {
            bookingId,
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

export async function listReceiptsForBooking(bookingId: string) {
  const receipts = await prisma.receipt.findMany({
    where: { bookingId },
    include: RECEIPT_INCLUDE,
    orderBy: { issuedAt: 'desc' },
  });
  return Promise.all(receipts.map(receiptToJson));
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
