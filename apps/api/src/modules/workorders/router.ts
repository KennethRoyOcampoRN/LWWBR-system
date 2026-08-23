import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { requireAuth } from '../auth/middleware.js';
import { requirePermission } from '../auth/requirePermission.js';
import { getMe } from '../auth/service.js';
import {
  assignWorkOrderSchema,
  changeWorkOrderStatusSchema,
  createWorkOrderSchema,
  listWorkOrdersQuerySchema,
} from './schema.js';
import {
  assignWorkOrder,
  changeWorkOrderStatus,
  createWorkOrder,
  getWorkOrder,
  listAssignableUsers,
  listWorkOrders,
} from './service.js';

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

// Gated on workorder:assign itself (not user:read — see
// listAssignableUsers's own doc comment for why a POC needs this without
// the general user directory). department is a required query param
// since an assign-picker is always scoped to one ticket's department.
// Registered before GET /work-orders/:id so "assignable-users" is never
// swallowed as an :id param — Express matches routes in registration
// order.
workOrdersRouter.get(
  '/work-orders/assignable-users',
  requirePermission('workorder:assign'),
  asyncHandler(async (req, res) => {
    const department = req.query.department as string;
    if (!department) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'department is required' } });
      return;
    }
    const users = await listAssignableUsers(department);
    res.status(200).json({ users });
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

// No single permission gate — assign requires workorder:assign, decided
// inside the service (same reasoning as units/router.ts's status route:
// the transition table is the source of truth, not the route).
workOrdersRouter.post(
  '/work-orders/:id/assign',
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = assignWorkOrderSchema.parse(req.body);
    const me = await getMe(req.userId as string);
    const workOrder = await assignWorkOrder(
      req.params.id as string,
      body,
      { id: me.id, department: me.department, roles: me.roles, permissions: me.permissions },
      { ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null },
    );
    res.status(200).json({ workOrder });
  }),
);

// Same pattern — which permission (workorder:update_status,
// workorder:close, workorder:verify) applies depends on the requested
// transition, per the shared transition table.
workOrdersRouter.post(
  '/work-orders/:id/status',
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = changeWorkOrderStatusSchema.parse(req.body);
    const me = await getMe(req.userId as string);
    const workOrder = await changeWorkOrderStatus(
      req.params.id as string,
      body,
      { id: me.id, department: me.department, roles: me.roles, permissions: me.permissions },
      { ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null },
    );
    res.status(200).json({ workOrder });
  }),
);
