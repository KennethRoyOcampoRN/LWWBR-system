import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { requirePermission } from '../auth/requirePermission.js';
import { createWorkOrderSchema, listWorkOrdersQuerySchema } from './schema.js';
import { createWorkOrder, getWorkOrder, listWorkOrders } from './service.js';

export const workOrdersRouter = Router();

// requirePermission already loaded req.authUser fresh from the database
// (never trusting the access token) — reused here rather than a second
// getMe() call, same pattern as units/router.ts's status-change route.
workOrdersRouter.post(
  '/work-orders',
  requirePermission('workorder:create'),
  asyncHandler(async (req, res) => {
    const body = createWorkOrderSchema.parse(req.body);
    const workOrder = await createWorkOrder(body, req.authUser!);
    res.status(201).json({ workOrder });
  }),
);

// Gated on workorder:read (the floor every role holds) — the actual
// row-level visibility (own tickets vs department vs everything) is
// decided inside listWorkOrders() based on whether the caller also
// holds workorder:read_all and at what scope. See service.ts's
// visibilityWhereClause for the reasoning.
workOrdersRouter.get(
  '/work-orders',
  requirePermission('workorder:read'),
  asyncHandler(async (req, res) => {
    const query = listWorkOrdersQuerySchema.parse(req.query);
    const workOrders = await listWorkOrders(query, req.authUser!);
    res.status(200).json({ workOrders });
  }),
);

workOrdersRouter.get(
  '/work-orders/:id',
  requirePermission('workorder:read'),
  asyncHandler(async (req, res) => {
    const workOrder = await getWorkOrder(req.params.id as string, req.authUser!);
    res.status(200).json({ workOrder });
  }),
);
