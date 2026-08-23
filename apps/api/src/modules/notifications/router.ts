import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { requireAuth } from '../auth/middleware.js';
import { listNotificationsQuerySchema } from './schema.js';
import { listNotifications, markNotificationRead } from './service.js';

export const notificationsRouter = Router();

// Spec §9: `GET /notifications  POST /notifications/:id/read`. No
// dedicated permission key — this is always scoped to the caller's own
// notifications (requireAuth only), same self-service pattern as
// SessionsPage's endpoints.
notificationsRouter.get(
  '/notifications',
  requireAuth,
  asyncHandler(async (req, res) => {
    const query = listNotificationsQuerySchema.parse(req.query);
    const notifications = await listNotifications(req.userId as string, query);
    res.status(200).json({ notifications });
  }),
);

notificationsRouter.post(
  '/notifications/:id/read',
  requireAuth,
  asyncHandler(async (req, res) => {
    await markNotificationRead(req.params.id as string, req.userId as string);
    res.status(204).send();
  }),
);
