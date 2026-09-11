import { REST_DAY_STATUS_KEYS } from '@lwwbr/shared';
import { z } from 'zod';

export const createRestDayRequestSchema = z.object({
  requestedDate: z.string().datetime(),
  reason: z.string().trim().max(500).optional(),
});
export type CreateRestDayRequestInput = z.infer<typeof createRestDayRequestSchema>;

export const listRestDayRequestsQuerySchema = z.object({
  status: z.enum(REST_DAY_STATUS_KEYS).optional(),
  // Self-service: a caller with only restday:request (no restday:approve)
  // always gets their own requests regardless of this flag — see
  // listRestDayRequests' own comment. mine=true is for an
  // restday:approve holder who wants their own submissions instead of
  // the full queue.
  mine: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});
export type ListRestDayRequestsQuery = z.infer<typeof listRestDayRequestsQuerySchema>;

export const changeRestDayRequestStatusSchema = z.object({
  toStatus: z.enum(['APPROVED', 'REJECTED']),
  decisionNote: z.string().trim().max(500).optional(),
});
export type ChangeRestDayRequestStatusInput = z.infer<typeof changeRestDayRequestStatusSchema>;
