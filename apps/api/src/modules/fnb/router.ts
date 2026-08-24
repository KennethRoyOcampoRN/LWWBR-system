import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { requireAuth } from '../auth/middleware.js';
import { requirePermission } from '../auth/requirePermission.js';
import { getMe } from '../auth/service.js';
import {
  changeFnbOrderStatusSchema,
  createFnbOrderSchema,
  createMenuItemSchema,
  listFnbOrdersQuerySchema,
  updateMenuItemSchema,
} from './schema.js';
import {
  changeFnbOrderStatus,
  createFnbOrder,
  createMenuItem,
  getFnbOrder,
  listFnbOrders,
  listMenuItems,
  updateMenuItem,
} from './service.js';

export const fnbRouter = Router();

fnbRouter.get(
  '/menu-items',
  requirePermission('fnb:read'),
  asyncHandler(async (_req, res) => {
    res.status(200).json({ menuItems: await listMenuItems() });
  }),
);

fnbRouter.post(
  '/menu-items',
  requirePermission('fnb:manage_menu'),
  asyncHandler(async (req, res) => {
    const body = createMenuItemSchema.parse(req.body);
    res.status(201).json({ menuItem: await createMenuItem(body) });
  }),
);

fnbRouter.patch(
  '/menu-items/:id',
  requirePermission('fnb:manage_menu'),
  asyncHandler(async (req, res) => {
    const body = updateMenuItemSchema.parse(req.body);
    res.status(200).json({ menuItem: await updateMenuItem(req.params.id as string, body) });
  }),
);

fnbRouter.post(
  '/fnb-orders',
  requirePermission('fnb:create'),
  asyncHandler(async (req, res) => {
    const body = createFnbOrderSchema.parse(req.body);
    const order = await createFnbOrder(body, { id: req.authUser!.id, permissions: req.authUser!.permissions });
    res.status(201).json({ fnbOrder: order });
  }),
);

fnbRouter.get(
  '/fnb-orders',
  requirePermission('fnb:read'),
  asyncHandler(async (req, res) => {
    const query = listFnbOrdersQuerySchema.parse(req.query);
    res.status(200).json({ fnbOrders: await listFnbOrders(query) });
  }),
);

fnbRouter.get(
  '/fnb-orders/:id',
  requirePermission('fnb:read'),
  asyncHandler(async (req, res) => {
    res.status(200).json({ fnbOrder: await getFnbOrder(req.params.id as string) });
  }),
);

// No single permission gate — every transition needs fnb:update_status
// per the shared table, but the pattern stays consistent with work
// orders'/units'/amenity-requests' status routes: the transition table
// is the source of truth, not the route.
fnbRouter.post(
  '/fnb-orders/:id/status',
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = changeFnbOrderStatusSchema.parse(req.body);
    const me = await getMe(req.userId as string);
    const order = await changeFnbOrderStatus(req.params.id as string, body, { id: me.id, permissions: me.permissions });
    res.status(200).json({ fnbOrder: order });
  }),
);
