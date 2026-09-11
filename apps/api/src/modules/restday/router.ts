import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { requirePermission } from '../auth/requirePermission.js';
import {
  changeRestDayRequestStatusSchema,
  createRestDayRequestSchema,
  listRestDayRequestsQuerySchema,
} from './schema.js';
import { changeRestDayRequestStatus, createRestDayRequest, listRestDayRequests } from './service.js';

export const restDayRouter = Router();

restDayRouter.post(
  '/restday-requests',
  requirePermission('restday:request'),
  asyncHandler(async (req, res) => {
    const body = createRestDayRequestSchema.parse(req.body);
    const request = await createRestDayRequest(body, { id: req.authUser!.id });
    res.status(201).json({ restDayRequest: request });
  }),
);

restDayRouter.get(
  '/restday-requests',
  requirePermission('restday:request'),
  asyncHandler(async (req, res) => {
    const query = listRestDayRequestsQuerySchema.parse(req.query);
    const requests = await listRestDayRequests(query, {
      id: req.authUser!.id,
      canApprove: Boolean(req.authUser!.permissions['restday:approve']),
    });
    res.status(200).json({ restDayRequests: requests });
  }),
);

restDayRouter.post(
  '/restday-requests/:id/status',
  requirePermission('restday:approve'),
  asyncHandler(async (req, res) => {
    const body = changeRestDayRequestStatusSchema.parse(req.body);
    const request = await changeRestDayRequestStatus(req.params.id as string, body, { id: req.authUser!.id });
    res.status(200).json({ restDayRequest: request });
  }),
);
