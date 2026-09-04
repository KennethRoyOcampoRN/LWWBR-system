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
import { createStockItem, createStockMovement, listStockItems, listStockMovements, updateStockItem } from './service.js';

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

stockRouter.get(
  '/stock-movements',
  requirePermission('stock:read'),
  asyncHandler(async (req, res) => {
    const query = listStockMovementsQuerySchema.parse(req.query);
    res.status(200).json({ stockMovements: await listStockMovements(query) });
  }),
);
