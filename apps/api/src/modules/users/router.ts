import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { requirePermission } from '../auth/requirePermission.js';
import { createUserSchema, updateUserSchema } from './schema.js';
import { createUser, listUsers, resetPassword, updateUser } from './service.js';

export const usersRouter = Router();

// Only SYSTEM_ADMIN holds user:read/user:manage in the seeded matrix
// (spec §5.4) — this router doesn't special-case that, it just asks
// requirePermission the same way every other module does.
usersRouter.get(
  '/users',
  requirePermission('user:read'),
  asyncHandler(async (_req, res) => {
    const users = await listUsers();
    res.status(200).json({ users });
  }),
);

usersRouter.post(
  '/users',
  requirePermission('user:manage'),
  asyncHandler(async (req, res) => {
    const body = createUserSchema.parse(req.body);
    const result = await createUser(body);
    // tempPassword is returned exactly once — the admin is responsible
    // for relaying it to the new hire out of band. It is never stored
    // in plaintext or retrievable again.
    res.status(201).json({ user: result.user, tempPassword: result.tempPassword });
  }),
);

usersRouter.patch(
  '/users/:id',
  requirePermission('user:manage'),
  asyncHandler(async (req, res) => {
    const body = updateUserSchema.parse(req.body);
    const user = await updateUser(req.params.id as string, body);
    res.status(200).json({ user });
  }),
);

usersRouter.post(
  '/users/:id/reset-password',
  requirePermission('user:manage'),
  asyncHandler(async (req, res) => {
    const result = await resetPassword(req.params.id as string);
    res.status(200).json({ tempPassword: result.tempPassword });
  }),
);
