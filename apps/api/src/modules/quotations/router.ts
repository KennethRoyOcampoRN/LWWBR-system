import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { requirePermission } from '../auth/requirePermission.js';
import { changeQuotationRequestStatusSchema, createQuotationRequestSchema, listQuotationRequestsQuerySchema } from './schema.js';
import { changeQuotationRequestStatus, createQuotationRequest, listQuotationRequests } from './service.js';

export const quotationsRouter = Router();

// Client-directed feature, 2026-08-31: a standalone quotation-request
// record. Create is deliberately not held by SYSTEM_ADMIN — see
// rolePermissions.ts's QUOTATION_STATUS comment — System Admin is the
// one role that marks a quotation Done/Pending, and can see every one,
// without also being able to create one.
quotationsRouter.post(
  '/quotation-requests',
  requirePermission('quotation:create'),
  asyncHandler(async (req, res) => {
    const body = createQuotationRequestSchema.parse(req.body);
    const request = await createQuotationRequest(body, { id: req.authUser!.id });
    res.status(201).json({ quotationRequest: request });
  }),
);

quotationsRouter.get(
  '/quotation-requests',
  requirePermission('quotation:read'),
  asyncHandler(async (req, res) => {
    const query = listQuotationRequestsQuerySchema.parse(req.query);
    res.status(200).json({ quotationRequests: await listQuotationRequests(query) });
  }),
);

quotationsRouter.post(
  '/quotation-requests/:id/status',
  requirePermission('quotation:update_status'),
  asyncHandler(async (req, res) => {
    const body = changeQuotationRequestStatusSchema.parse(req.body);
    const request = await changeQuotationRequestStatus(req.params.id as string, body, { id: req.authUser!.id });
    res.status(200).json({ quotationRequest: request });
  }),
);
