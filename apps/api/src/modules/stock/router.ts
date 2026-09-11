import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { requirePermission } from '../auth/requirePermission.js';
import {
  createStockItemSchema,
  createStockMovementSchema,
  listStockItemsQuerySchema,
  listStockMovementsQuerySchema,
  updateStockItemSchema,
} from './schema.js';
import {
  createStockItem,
  createStockMovement,
  deleteStockItem,
  listStockItems,
  listStockMovements,
  updateStockItem,
} from './service.js';

export const stockRouter = Router();

// Client-directed feature, 2026-08-31: stock monitoring and purchasing,
// in/out only — no StockRequest approval workflow. See stock/service.ts's
// listLowStockItems's own comment for why the Command Center KPI/queue
// this powers is deliberately unscoped by any of these permissions.
stockRouter.post(
  '/stock-items',
  requirePermission('stock:manage'),
  asyncHandler(async (req, res) => {
    const body = createStockItemSchema.parse(req.body);
    const item = await createStockItem(body, { id: req.authUser!.id });
    res.status(201).json({ stockItem: item });
  }),
);

stockRouter.get(
  '/stock-items',
  requirePermission('stock:read'),
  asyncHandler(async (req, res) => {
    const query = listStockItemsQuerySchema.parse(req.query);
    res.status(200).json({ stockItems: await listStockItems(query) });
  }),
);

stockRouter.patch(
  '/stock-items/:id',
  requirePermission('stock:manage'),
  asyncHandler(async (req, res) => {
    const body = updateStockItemSchema.parse(req.body);
    const item = await updateStockItem(req.params.id as string, body, { id: req.authUser!.id });
    res.status(200).json({ stockItem: item });
  }),
);

stockRouter.post(
  '/stock-items/:id/movements',
  requirePermission('stock:log_movement'),
  asyncHandler(async (req, res) => {
    const body = createStockMovementSchema.parse(req.body);
    const movement = await createStockMovement(req.params.id as string, body, { id: req.authUser!.id });
    res.status(201).json({ stockMovement: movement });
  }),
);

// Client-directed feature, 2026-09-11: a genuine soft-delete (deletedAt),
// NOT the hard-delete pattern fnb/router.ts's DELETE /menu-items uses —
// see deleteStockItem's own comment for why that pattern isn't safely
// reusable here without a schema change. Same permission as everything
// else on this page (stock:manage) and the same "only once deactivated"
// gate as Amenities/F&B's delete.
stockRouter.delete(
  '/stock-items/:id',
  requirePermission('stock:manage'),
  asyncHandler(async (req, res) => {
    await deleteStockItem(req.params.id as string, { id: req.authUser!.id });
    res.status(204).end();
  }),
);

stockRouter.get(
  '/stock-movements',
  requirePermission('stock:read'),
  asyncHandler(async (req, res) => {
    const query = listStockMovementsQuerySchema.parse(req.query);
    res.status(200).json({ stockMovements: await listStockMovements(query) });
  }),
);
