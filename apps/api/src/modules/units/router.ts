import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { requireAuth } from '../auth/middleware.js';
import { requirePermission } from '../auth/requirePermission.js';
import { getMe } from '../auth/service.js';
import {
  changeUnitStatusSchema,
  createUnitSchema,
  createUnitTypeSchema,
  updateUnitSchema,
  updateUnitTypeSchema,
} from './schema.js';
import {
  changeUnitStatus,
  createUnit,
  createUnitType,
  getUnitTimeline,
  listUnits,
  listUnitTypes,
  updateUnit,
  updateUnitType,
} from './service.js';

export const unitsRouter = Router();

unitsRouter.get(
  '/unit-types',
  requirePermission('unit:read'),
  asyncHandler(async (_req, res) => {
    res.status(200).json({ unitTypes: await listUnitTypes() });
  }),
);

unitsRouter.post(
  '/unit-types',
  requirePermission('unittype:manage'),
  asyncHandler(async (req, res) => {
    const body = createUnitTypeSchema.parse(req.body);
    res.status(201).json({ unitType: await createUnitType(body) });
  }),
);

unitsRouter.patch(
  '/unit-types/:id',
  requirePermission('unittype:manage'),
  asyncHandler(async (req, res) => {
    const body = updateUnitTypeSchema.parse(req.body);
    res.status(200).json({ unitType: await updateUnitType(req.params.id as string, body) });
  }),
);

unitsRouter.get(
  '/units',
  requirePermission('unit:read'),
  asyncHandler(async (_req, res) => {
    res.status(200).json({ units: await listUnits() });
  }),
);

unitsRouter.post(
  '/units',
  requirePermission('unit:manage'),
  asyncHandler(async (req, res) => {
    const body = createUnitSchema.parse(req.body);
    res.status(201).json({ unit: await createUnit(body) });
  }),
);

unitsRouter.patch(
  '/units/:id',
  requirePermission('unit:manage'),
  asyncHandler(async (req, res) => {
    const body = updateUnitSchema.parse(req.body);
    res.status(200).json({ unit: await updateUnit(req.params.id as string, body) });
  }),
);

unitsRouter.get(
  '/units/:id/timeline',
  requirePermission('unit:read'),
  asyncHandler(async (req, res) => {
    res.status(200).json({ events: await getUnitTimeline(req.params.id as string) });
  }),
);

// No single permission gate here — which permission is required depends
// on the requested transition (unit:update_status, workorder:verify, or
// unit:block, per the shared transition table), so this only needs
// requireAuth (identity only) plus a fresh load of the caller's actual
// permissions, exactly like requirePermission does internally — never
// trusting anything cached in the access token.
unitsRouter.post(
  '/units/:id/status',
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = changeUnitStatusSchema.parse(req.body);
    const me = await getMe(req.userId as string);
    const result = await changeUnitStatus(req.params.id as string, body, { id: me.id, permissions: me.permissions });
    res.status(200).json(result);
  }),
);
