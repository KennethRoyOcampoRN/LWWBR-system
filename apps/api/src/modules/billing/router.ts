import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { requirePermission } from '../auth/requirePermission.js';
import {
  changePaymentStatusSchema,
  issueReceiptSchema,
  postFolioChargeSchema,
  receiptDraftSchema,
  submitPaymentSchema,
  voidFolioChargeSchema,
  voidReceiptSchema,
} from './schema.js';
import {
  changePaymentStatus,
  getReceipt,
  issueReceipt,
  listFolioCharges,
  listPayments,
  listReceiptsForBooking,
  listUnsettledFnbCharges,
  postFolioCharge,
  previewReceipt,
  submitPayment,
  voidFolioCharge,
  voidReceipt,
} from './service.js';

export const billingRouter = Router();

// Build plan stage 3 (spec.md §13 decision 13, 2026-11-04): folio
// line-item CRUD, payment submission/verification, and receipt
// issuance. API only — no UI yet (stage 4).

billingRouter.get(
  '/bookings/:bookingId/folio-charges',
  requirePermission('folio:read'),
  asyncHandler(async (req, res) => {
    res.status(200).json({ folioCharges: await listFolioCharges(req.params.bookingId as string) });
  }),
);

billingRouter.post(
  '/bookings/:bookingId/folio-charges',
  requirePermission('folio:charge'),
  asyncHandler(async (req, res) => {
    const body = postFolioChargeSchema.parse(req.body);
    const folioCharge = await postFolioCharge(req.params.bookingId as string, body, { id: req.authUser!.id });
    res.status(201).json({ folioCharge });
  }),
);

billingRouter.post(
  '/folio-charges/:id/void',
  requirePermission('folio:void'),
  asyncHandler(async (req, res) => {
    const body = voidFolioChargeSchema.parse(req.body);
    const folioCharge = await voidFolioCharge(req.params.id as string, body, { id: req.authUser!.id });
    res.status(200).json({ folioCharge });
  }),
);

billingRouter.get(
  '/bookings/:bookingId/payments',
  requirePermission('payment:read'),
  asyncHandler(async (req, res) => {
    res.status(200).json({ payments: await listPayments(req.params.bookingId as string) });
  }),
);

billingRouter.post(
  '/bookings/:bookingId/payments',
  requirePermission('payment:submit'),
  asyncHandler(async (req, res) => {
    const body = submitPaymentSchema.parse(req.body);
    const payment = await submitPayment(req.params.bookingId as string, body, { id: req.authUser!.id });
    res.status(201).json({ payment });
  }),
);

// Bidirectional — one route marks VERIFIED/REJECTED or reverts to
// PENDING, same shape as remittances' own POST /remittance-requests/:id/status.
billingRouter.post(
  '/payments/:id/status',
  requirePermission('payment:verify'),
  asyncHandler(async (req, res) => {
    const body = changePaymentStatusSchema.parse(req.body);
    const payment = await changePaymentStatus(req.params.id as string, body, { id: req.authUser!.id });
    res.status(200).json({ payment });
  }),
);

// Build plan stage 2 follow-up (client, 2026-11-04): resolves the gap
// flagged after stage 2 — GET /settings/resort-identity is
// resort:configure-only, which CASHIER/ADMIN_STAFF/ADMIN_HEAD don't
// hold, so a billing screen that previewed the header via that route
// would 403 for the people who actually issue receipts. This preview
// endpoint is gated by receipt:issue instead (the permission everyone
// who bills a guest already holds) and reads the resort-identity
// Setting server-side — the cashier UI never calls
// /settings/resort-identity directly. Computes the exact same totals
// issueReceipt below would, from the exact same draft shape
// (receiptDraftSchema), so what's previewed is never a different
// calculation than what gets persisted on confirm.
// Cashier-tab plan (spec.md §13.4, Stage B, 2026-11-05): the F&B
// pull-in's read side — gated receipt:issue, same as the preview
// endpoint below, since this is specifically for billing use.
billingRouter.get(
  '/bookings/:bookingId/unsettled-fnb-charges',
  requirePermission('receipt:issue'),
  asyncHandler(async (req, res) => {
    res.status(200).json({ charges: await listUnsettledFnbCharges(req.params.bookingId as string) });
  }),
);

billingRouter.post(
  '/bookings/:bookingId/receipts/preview',
  requirePermission('receipt:issue'),
  asyncHandler(async (req, res) => {
    const body = receiptDraftSchema.parse(req.body);
    res.status(200).json(await previewReceipt(req.params.bookingId as string, body));
  }),
);

billingRouter.post(
  '/bookings/:bookingId/receipts',
  requirePermission('receipt:issue'),
  asyncHandler(async (req, res) => {
    const body = issueReceiptSchema.parse(req.body);
    const receipt = await issueReceipt(req.params.bookingId as string, body, { id: req.authUser!.id });
    res.status(201).json({ receipt });
  }),
);

billingRouter.get(
  '/bookings/:bookingId/receipts',
  requirePermission('receipt:read'),
  asyncHandler(async (req, res) => {
    res.status(200).json({ receipts: await listReceiptsForBooking(req.params.bookingId as string) });
  }),
);

billingRouter.get(
  '/receipts/:id',
  requirePermission('receipt:read'),
  asyncHandler(async (req, res) => {
    res.status(200).json({ receipt: await getReceipt(req.params.id as string) });
  }),
);

// folio:void, not a new receipt:void key — same reuse-rather-than-widen
// decision already made for the schema (spec.md §13 decision 13 build
// plan): voiding a receipt is the same class of action as voiding a
// folio charge, gated the same way.
billingRouter.post(
  '/receipts/:id/void',
  requirePermission('folio:void'),
  asyncHandler(async (req, res) => {
    const body = voidReceiptSchema.parse(req.body);
    const receipt = await voidReceipt(req.params.id as string, body, { id: req.authUser!.id });
    res.status(200).json({ receipt });
  }),
);
