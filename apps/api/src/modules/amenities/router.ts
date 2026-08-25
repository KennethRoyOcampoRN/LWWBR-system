import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { requireAuth } from '../auth/middleware.js';
import { requirePermission } from '../auth/requirePermission.js';
import { getMe } from '../auth/service.js';
import {
  changeAmenityRequestStatusSchema,
  createAmenityItemSchema,
  createAmenityRequestSchema,
  listAmenityRequestsQuerySchema,
  updateAmenityItemSchema,
} from './schema.js';
import {
  changeAmenityRequestStatus,
  createAmenityItem,
  createAmenityRequest,
  deleteAmenityItem,
  getAmenityRequest,
  listAmenityItems,
  listAmenityRequests,
  updateAmenityItem,
} from './service.js';

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

// Client decision, 2026-08-25 (Option B): genuine hard delete, now that
// AmenityRequest snapshots the item's name at request time. Not a
// deletedAt soft-hide — the row is actually removed.
amenitiesRouter.delete(
  '/amenity-items/:id',
  requirePermission('amenity:manage'),
  asyncHandler(async (req, res) => {
    await deleteAmenityItem(req.params.id as string);
    res.status(204).end();
  }),
);

amenitiesRouter.post(
  '/amenity-requests',
  requirePermission('amenity:request'),
  asyncHandler(async (req, res) => {
    const body = createAmenityRequestSchema.parse(req.body);
    const request = await createAmenityRequest(body, { id: req.authUser!.id, permissions: req.authUser!.permissions });
    res.status(201).json({ amenityRequest: request });
  }),
);

amenitiesRouter.get(
  '/amenity-requests',
  requirePermission('amenity:read'),
  asyncHandler(async (req, res) => {
    const query = listAmenityRequestsQuerySchema.parse(req.query);
    res.status(200).json({ amenityRequests: await listAmenityRequests(query) });
  }),
);

amenitiesRouter.get(
  '/amenity-requests/:id',
  requirePermission('amenity:read'),
  asyncHandler(async (req, res) => {
    res.status(200).json({ amenityRequest: await getAmenityRequest(req.params.id as string) });
  }),
);

// No single permission gate — which key applies (amenity:approve,
// amenity:issue, amenity:return) depends on the requested transition,
// per the shared transition table. Same requireAuth + getMe pattern as
// work orders' and units' status-change routes: the transition table is
// the source of truth, not the route.
amenitiesRouter.post(
  '/amenity-requests/:id/status',
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = changeAmenityRequestStatusSchema.parse(req.body);
    const me = await getMe(req.userId as string);
    const request = await changeAmenityRequestStatus(req.params.id as string, body, {
      id: me.id,
      permissions: me.permissions,
    });
    res.status(200).json({ amenityRequest: request });
  }),
);
