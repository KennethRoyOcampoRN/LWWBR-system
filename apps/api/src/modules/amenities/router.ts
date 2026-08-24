import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { requirePermission } from '../auth/requirePermission.js';
import { createAmenityItemSchema, updateAmenityItemSchema } from './schema.js';
import { createAmenityItem, listAmenityItems, updateAmenityItem } from './service.js';

export const amenitiesRouter = Router();

amenitiesRouter.get(
  '/amenity-items',
  requirePermission('amenity:read'),
  asyncHandler(async (_req, res) => {
    res.status(200).json({ amenityItems: await listAmenityItems() });
  }),
);

amenitiesRouter.post(
  '/amenity-items',
  requirePermission('amenity:manage'),
  asyncHandler(async (req, res) => {
    const body = createAmenityItemSchema.parse(req.body);
    res.status(201).json({ amenityItem: await createAmenityItem(body) });
  }),
);

amenitiesRouter.patch(
  '/amenity-items/:id',
  requirePermission('amenity:manage'),
  asyncHandler(async (req, res) => {
    const body = updateAmenityItemSchema.parse(req.body);
    res.status(200).json({ amenityItem: await updateAmenityItem(req.params.id as string, body) });
  }),
);
