import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { requireAuth } from '../auth/middleware.js';
import { requirePermission } from '../auth/requirePermission.js';
import { getMe } from '../auth/service.js';
import {
  changeUnitStatusSchema,
  createUnitSchema,
  createUnitTypeSchema,
  forceUnitStatusSchema,
  updateUnitSchema,
  updateUnitTypeSchema,
} from './schema.js';
import {
  changeUnitStatus,
  createUnit,
  createUnitType,
  deleteUnit,
  forceUnitStatus,
  getUnitsDashboard,
  getUnitTimeline,
  listOrderableUnits,
  listUnitActivity,
  listUnits,
  listUnitTypes,
  updateUnit,
  updateUnitType,
} from './service.js';

const DEFAULT_ACTIVITY_LIMIT = 20;
const MAX_ACTIVITY_LIMIT = 50;

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

// Client decision, 2026-08-25: genuine hard delete, but only for a unit
// with zero real history — see deleteUnit's own doc comment for the full
// reasoning. Not a deletedAt soft-hide; the row is actually removed.
unitsRouter.delete(
  '/units/:id',
  requirePermission('unit:manage'),
  asyncHandler(async (req, res) => {
    await deleteUnit(req.params.id as string);
    res.status(204).end();
  }),
);

// Narrowly-scoped picker for F&B order creation — see
// listOrderableUnits's own doc comment for why this is gated on
// fnb:create rather than unit:read (Restaurant Staff holds the former
// but not the latter).
unitsRouter.get(
  '/units/orderable',
  requirePermission('fnb:create'),
  asyncHandler(async (_req, res) => {
    res.status(200).json({ units: await listOrderableUnits() });
  }),
);

// Spec §8.2 Command Center: KPI strip counts, the "rooms dirty >3h" item,
// SLA-breached work orders, open urgent work orders, and today's guest
// turnover (check-ins/check-outs) — all computed live from
// Unit/UnitStatusEvent/WorkOrder data. Deliberately unit:read-gated, not
// workorder:read — see getUnitsDashboard's own doc comment for why that's
// not a permission leak in practice, and for what's still deliberately NOT
// here (payments is permanently out of scope, not deferred) and why.
//
// remittance:*/quotation:* fields (2026-08-31) are the first exception to
// "unit:read alone justifies every field" — requirePermission already
// loads the caller's full permission set fresh via getMe() and attaches
// it to req.authUser, so passing it through costs no extra query;
// getUnitsDashboard uses it to omit those fields entirely for a caller
// who doesn't hold the matching permission (see its own doc comment).
unitsRouter.get(
  '/units/dashboard',
  requirePermission('unit:read'),
  asyncHandler(async (req, res) => {
    res.status(200).json(await getUnitsDashboard(req.authUser!.permissions));
  }),
);

// Spec §8.2 live activity feed's initial backfill — see listUnitActivity's
// doc comment. Ongoing updates reach the page via the existing
// unit.status.changed realtime broadcast, not by polling this endpoint.
unitsRouter.get(
  '/units/activity',
  requirePermission('unit:read'),
  asyncHandler(async (req, res) => {
    const requested = Number.parseInt(req.query.limit as string, 10);
    const limit =
      Number.isFinite(requested) && requested > 0 ? Math.min(requested, MAX_ACTIVITY_LIMIT) : DEFAULT_ACTIVITY_LIMIT;
    res.status(200).json({ events: await listUnitActivity(limit) });
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
// on the requested transition (unit:update_status, unit:block, or
// unit:manage for an automatic-only override, per the shared transition
// table), so this only needs requireAuth (identity only) plus a fresh
// load of the caller's actual permissions, exactly like requirePermission
// does internally — never trusting anything cached in the access token.
unitsRouter.post(
  '/units/:id/status',
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = changeUnitStatusSchema.parse(req.body);
    const me = await getMe(req.userId as string);
    const result = await changeUnitStatus(
      req.params.id as string,
      body,
      { id: me.id, roles: me.roles, permissions: me.permissions },
      { ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null },
    );
    res.status(200).json(result);
  }),
);

// Forced status correction (client decision, 2026-08-22): distinct from
// the transition above, this is gated by a single dedicated permission
// (unit:force_status) rather than a per-transition lookup, since it
// deliberately allows jumping to ANY of the 8 statuses. Still requireAuth
// + getMe() (not requirePermission) because the service function needs
// the caller's full permission set to produce a proper 403, and to stay
// consistent with how changeUnitStatus does its own check.
unitsRouter.post(
  '/units/:id/force-status',
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = forceUnitStatusSchema.parse(req.body);
    const me = await getMe(req.userId as string);
    const result = await forceUnitStatus(
      req.params.id as string,
      body,
      { id: me.id, permissions: me.permissions },
      { ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null },
    );
    res.status(200).json(result);
  }),
);
