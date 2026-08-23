import { z } from 'zod';

// Spec §9's documented surface is just `GET /notifications`, no query
// params listed — `unread` is an additive, optional narrowing for the
// bell dropdown's "unread only" default, not a spec requirement.
export const listNotificationsQuerySchema = z.object({
  unread: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;
