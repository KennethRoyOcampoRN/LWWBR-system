import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { requirePermission } from '../auth/requirePermission.js';
import { changeRemittanceRequestStatusSchema, createRemittanceRequestSchema, listRemittanceRequestsQuerySchema } from './schema.js';
import { changeRemittanceRequestStatus, createRemittanceRequest, listRemittanceRequests } from './service.js';

export const remittancesRouter = Router();

// Client-directed feature, 2026-08-31: an incoming guest payment
// (manually-booked guest, paid via bank transfer/GCash/etc.) submitted
// for OWNER to verify — see remittances/service.ts's own header comment
// for why this is a standalone module, unrelated to bookings/units/
// folio, and why it's `remittance:*`, not `payment:*`.
remittancesRouter.post(
  '/remittance-requests',
  requirePermission('remittance:create'),
  asyncHandler(async (req, res) => {
    const body = createRemittanceRequestSchema.parse(req.body);
    const request = await createRemittanceRequest(body, { id: req.authUser!.id });
    res.status(201).json({ remittanceRequest: request });
  }),
);

remittancesRouter.get(
  '/remittance-requests',
  requirePermission('remittance:read'),
  asyncHandler(async (req, res) => {
    const query = listRemittanceRequestsQuerySchema.parse(req.query);
    res.status(200).json({ remittanceRequests: await listRemittanceRequests(query) });
  }),
);

// Bidirectional — the same route marks VERIFIED or reverts to
// FOR_VERIFICATION, gated by the single remittance:verify permission
// (OWNER only). See schema.ts's own comment for why this isn't split
// into two routes.
remittancesRouter.post(
  '/remittance-requests/:id/status',
  requirePermission('remittance:verify'),
  asyncHandler(async (req, res) => {
    const body = changeRemittanceRequestStatusSchema.parse(req.body);
    const request = await changeRemittanceRequestStatus(req.params.id as string, body, { id: req.authUser!.id });
    res.status(200).json({ remittanceRequest: request });
  }),
);
