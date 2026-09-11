import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { requirePermission } from '../auth/requirePermission.js';
import { createShiftSchema, listShiftsQuerySchema, updateShiftSchema } from './schema.js';
import { createShift, deleteShift, listAssignableUsers, listShifts, updateShift } from './service.js';

export const shiftsRouter = Router();

// Client-directed feature, 2026-09-18: shift roster + reliever
// assignment, part of the standalone Shifts & DTR page (see
// shifts/service.ts's own comment). shift:read is the universal floor
// every role already holds (see rolePermissions.ts) — this is the one
// place that's genuinely true property-wide, not gated further.
shiftsRouter.post(
  '/shifts',
  requirePermission('shift:manage'),
  asyncHandler(async (req, res) => {
    const body = createShiftSchema.parse(req.body);
    const shift = await createShift(body);
    res.status(201).json({ shift });
  }),
);

// Gated on shift:manage itself (not user:read) — see
// listAssignableUsers's own doc comment for why.
shiftsRouter.get(
  '/shifts/assignable-users',
  requirePermission('shift:manage'),
  asyncHandler(async (_req, res) => {
    const users = await listAssignableUsers();
    res.status(200).json({ users });
  }),
);

shiftsRouter.get(
  '/shifts',
  requirePermission('shift:read'),
  asyncHandler(async (req, res) => {
    const query = listShiftsQuerySchema.parse(req.query);
    res.status(200).json({ shifts: await listShifts(query) });
  }),
);

shiftsRouter.patch(
  '/shifts/:id',
  requirePermission('shift:manage'),
  asyncHandler(async (req, res) => {
    const body = updateShiftSchema.parse(req.body);
    const shift = await updateShift(req.params.id as string, body);
    res.status(200).json({ shift });
  }),
);

// Client follow-up, 2026-09-18: cancel/delete a mistaken roster entry —
// see deleteShift's own comment for why this is a soft-delete, not the
// hard-delete pattern used elsewhere.
shiftsRouter.delete(
  '/shifts/:id',
  requirePermission('shift:manage'),
  asyncHandler(async (req, res) => {
    await deleteShift(req.params.id as string);
    res.status(204).end();
  }),
);
