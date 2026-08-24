import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { requirePermission } from '../auth/requirePermission.js';
import { createMenuItemSchema, updateMenuItemSchema } from './schema.js';
import { createMenuItem, listMenuItems, updateMenuItem } from './service.js';

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
