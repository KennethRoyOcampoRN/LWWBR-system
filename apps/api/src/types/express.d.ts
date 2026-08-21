// Augments Express's Request with the fields requireAuth/requirePermission
// attach.
import type {} from 'express';
import type { PermissionScope } from '@lwwbr/shared';
import type { AuthenticatedUser } from '../modules/auth/service.js';

declare global {
  namespace Express {
    interface Request {
      userId?: string;
      authUser?: AuthenticatedUser;
      permissionScope?: PermissionScope;
    }
  }
}

export {};
