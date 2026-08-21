import type { PermissionKey } from '@lwwbr/shared';
import type { NextFunction, Request, Response } from 'express';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { ApiError } from '../../lib/apiError.js';
import { getAuthenticatedUserId } from './middleware.js';
import { getMe } from './service.js';

// The single authorization primitive for the whole API — spec §5.1:
// "Do not hardcode role names in business logic... all authorization
// checks are permission checks." Never trust anything cached in the
// access token: this loads the caller's current roles from the database
// on every call, via getMe (§5.1's union-of-roles rule lives in
// packages/shared's getEffectivePermissions, called from there).
//
// Only confirms the caller holds `key` at *some* scope (ALL, DEPARTMENT,
// or SELF) — it does not filter query results. A route handler for a
// DEPARTMENT- or SELF-scoped resource reads req.permissionScope (and
// req.authUser.department / req.authUser.id) to decide how to narrow its
// own query; that filtering is the resource module's job (M2+), not
// something this generic middleware can know how to do for an
// as-yet-unbuilt resource.
export function requirePermission(key: PermissionKey) {
  return asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
    const userId = getAuthenticatedUserId(req);
    const user = await getMe(userId);
    const scope = user.permissions[key];
    if (!scope) {
      throw new ApiError(403, 'FORBIDDEN', `Missing permission: ${key}`);
    }
    req.userId = userId;
    req.authUser = user;
    req.permissionScope = scope;
    next();
  });
}
