import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { requirePermission } from '../auth/requirePermission.js';
import { createRatePlanSchema, setRatePlanRateSchema, updateRatePlanSchema } from './schema.js';
import { createRatePlan, deleteRatePlan, deleteRatePlanRate, listRatePlans, setRatePlanRate, updateRatePlan } from './service.js';

export const ratePlansRouter = Router();

// Spec.md §13 decision 29 (2026-11-15): rateplan:manage-gated admin CRUD
// for the Setup Rates UI (not yet built — this is the schema/service
// layer only). The cashier-facing read/suggest surface this plan also
// needs lives in billing/router.ts instead, gated folio:charge like
// everything else a cashier does at billing time — see that module's
// own GET /bookings/:bookingId/rate-plans route.

ratePlansRouter.get(
  '/rate-plans',
  requirePermission('rateplan:manage'),
  asyncHandler(async (_req, res) => {
    res.status(200).json({ ratePlans: await listRatePlans() });
  }),
);

ratePlansRouter.post(
  '/rate-plans',
  requirePermission('rateplan:manage'),
  asyncHandler(async (req, res) => {
    const body = createRatePlanSchema.parse(req.body);
    const ratePlan = await createRatePlan(body, { id: req.authUser!.id });
    res.status(201).json({ ratePlan });
  }),
);

ratePlansRouter.patch(
  '/rate-plans/:id',
  requirePermission('rateplan:manage'),
  asyncHandler(async (req, res) => {
    const body = updateRatePlanSchema.parse(req.body);
    const ratePlan = await updateRatePlan(req.params.id as string, body, { id: req.authUser!.id });
    res.status(200).json({ ratePlan });
  }),
);

ratePlansRouter.delete(
  '/rate-plans/:id',
  requirePermission('rateplan:manage'),
  asyncHandler(async (req, res) => {
    await deleteRatePlan(req.params.id as string, { id: req.authUser!.id });
    res.status(204).end();
  }),
);

ratePlansRouter.put(
  '/rate-plans/:id/rates/:unitTypeId',
  requirePermission('rateplan:manage'),
  asyncHandler(async (req, res) => {
    const body = setRatePlanRateSchema.parse(req.body);
    const rate = await setRatePlanRate(req.params.id as string, req.params.unitTypeId as string, body, { id: req.authUser!.id });
    res.status(200).json({ rate });
  }),
);

// Spec.md §13 decision 29: the client's own "fail loudly" escape hatch
// — removing a plan's rate for one room type, exercised here, means
// resolveRatePlanRate 422s the next time that room type is charged
// under this plan, rather than silently falling through to anything.
ratePlansRouter.delete(
  '/rate-plans/:id/rates/:unitTypeId',
  requirePermission('rateplan:manage'),
  asyncHandler(async (req, res) => {
    await deleteRatePlanRate(req.params.id as string, req.params.unitTypeId as string, { id: req.authUser!.id });
    res.status(204).end();
  }),
);
