import { FOLIO_CHARGE_SOURCE_KEYS, PAYMENT_KIND_KEYS, PAYMENT_METHOD_KEYS, RECEIPT_DEDUCTION_TYPE_KEYS } from '@lwwbr/shared';
import { z } from 'zod';

// Build plan stage 3 (spec.md §13 decision 13, 2026-11-04): folio
// line-item CRUD, payment submission/verification, and receipt
// issuance — same zod style as every other module's schema.ts
// (geofenceInputSchema, createRemittanceRequestSchema).

export const postFolioChargeSchema = z.object({
  source: z.enum(FOLIO_CHARGE_SOURCE_KEYS),
  sourceId: z.string().min(1).optional(),
  description: z.string().trim().min(1).max(300),
  qty: z.number().int().positive().default(1),
  unitPrice: z.number().nonnegative(),
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

const receiptLineInputSchema = z.object({
  description: z.string().trim().min(1).max(300),
  qty: z.number().int().positive(),
  unitPrice: z.number().nonnegative(),
  sourceChargeId: z.string().min(1).optional(),
});

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
// Deliberately permissive here (empty lines, blank preparedByName
// allowed) — build plan stage 4 (2026-11-04): the billing page's first
// preview call, made the moment a booking is opened for billing, has no
// lines yet and exists only to fetch the resort header/guest block
// (there's no standalone "GET /bookings/:id" — see this module's own
// README entry). `issueReceiptSchema` below tightens both back to
// required for the real, money-moving call.
export const receiptDraftSchema = z.object({
  guestContactNo: z.string().trim().max(50).nullable().optional(),
  guestEmail: z.string().trim().max(200).nullable().optional(),
  checkInDate: z.string().datetime().nullable().optional(),
  checkOutDate: z.string().datetime().nullable().optional(),
  nightsOfStay: z.number().int().positive().nullable().optional(),
  preparedByName: z.string().trim().max(200).default(''),
  lines: z.array(receiptLineInputSchema).default([]),
  deductions: z.array(receiptDeductionInputSchema).default([]),
});
export type ReceiptDraftInput = z.infer<typeof receiptDraftSchema>;

export const issueReceiptSchema = receiptDraftSchema.extend({
  preparedByName: z.string().trim().min(1).max(200),
  lines: z.array(receiptLineInputSchema).min(1, 'At least one line item is required.'),
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
