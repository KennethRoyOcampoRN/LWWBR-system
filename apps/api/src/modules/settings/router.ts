import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { requirePermission } from '../auth/requirePermission.js';
import { resortIdentityInputSchema } from './schema.js';
import { getResortIdentity, updateResortIdentity } from './service.js';

export const settingsRouter = Router();

// Build plan stage 2 (spec.md §13 decision 13): resort-identity
// settings — the first dedicated Settings admin endpoint this codebase
// has (every other Setting key, e.g. workOrder.photoRequirements, is
// read-only-in-code today, edited only at the DB/seed level). Gated by
// resort:configure for both read and write, same "config read needs
// the same permission as the write it protects" shape as DTR's own
// geofence endpoints (system:configure on all four verbs there).
settingsRouter.get(
  '/settings/resort-identity',
  requirePermission('resort:configure'),
  asyncHandler(async (_req, res) => {
    res.status(200).json({ resortIdentity: await getResortIdentity() });
  }),
);

settingsRouter.patch(
  '/settings/resort-identity',
  requirePermission('resort:configure'),
  asyncHandler(async (req, res) => {
    const body = resortIdentityInputSchema.parse(req.body);
    const resortIdentity = await updateResortIdentity(body, req.authUser!.id);
    res.status(200).json({ resortIdentity });
  }),
);
