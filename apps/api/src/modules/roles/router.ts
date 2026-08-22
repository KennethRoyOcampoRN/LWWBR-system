import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { requirePermission } from '../auth/requirePermission.js';
import { createRoleSchema, updateRolePermissionsSchema, updateRoleSchema } from './schema.js';
import { createRole, listPermissions, listRoles, updateRole, updateRolePermissions } from './service.js';

export const rolesRouter = Router();

// Spec §5.4: role:manage is granted to SYSTEM_ADMIN only — there's no
// dedicated role:read key, so the read endpoints below gate on the same
// permission as the writes rather than being open to every authenticated
// user.
rolesRouter.get(
  '/roles',
  requirePermission('role:manage'),
  asyncHandler(async (_req, res) => {
    const roles = await listRoles();
    res.status(200).json({ roles });
  }),
);

rolesRouter.post(
  '/roles',
  requirePermission('role:manage'),
  asyncHandler(async (req, res) => {
    const body = createRoleSchema.parse(req.body);
    const role = await createRole(body);
    res.status(201).json({ role });
  }),
);

rolesRouter.patch(
  '/roles/:id',
  requirePermission('role:manage'),
  asyncHandler(async (req, res) => {
    const body = updateRoleSchema.parse(req.body);
    const role = await updateRole(req.params.id as string, body);
    res.status(200).json({ role });
  }),
);

rolesRouter.put(
  '/roles/:id/permissions',
  requirePermission('role:manage'),
  asyncHandler(async (req, res) => {
    const body = updateRolePermissionsSchema.parse(req.body);
    const role = await updateRolePermissions(req.params.id as string, body);
    res.status(200).json({ role });
  }),
);

rolesRouter.get(
  '/permissions',
  requirePermission('role:manage'),
  asyncHandler(async (_req, res) => {
    const permissions = await listPermissions();
    res.status(200).json({ permissions });
  }),
);
