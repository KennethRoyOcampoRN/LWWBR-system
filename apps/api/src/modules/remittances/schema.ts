import { REMITTANCE_STATUS_KEYS } from '@lwwbr/shared';
import { z } from 'zod';

// Client-directed feature, 2026-08-31: an incoming guest payment (a
// manually-booked guest paid via bank transfer/GCash/etc.) submitted for
// OWNER to verify. Pure standalone record — no unitId/bookingId, unlike
// AmenityRequest/WorkOrder, since the client was explicit this doesn't
// connect to bookings, units, or folio.
export const createRemittanceRequestSchema = z.object({
  name: z.string().trim().min(1).max(200),
  date: z.string().datetime(),
  modeOfPayment: z.string().trim().min(1).max(100),
  amount: z.number().positive(),
  referenceNumber: z.string().trim().min(1).max(100),
  proofFileId: z.string().min(1).optional(),
});

export type CreateRemittanceRequestInput = z.infer<typeof createRemittanceRequestSchema>;

export const listRemittanceRequestsQuerySchema = z.object({
  status: z.enum(REMITTANCE_STATUS_KEYS).optional(),
});

export type ListRemittanceRequestsQuery = z.infer<typeof listRemittanceRequestsQuerySchema>;

// Bidirectional per the client's own spec — VERIFIED can revert back to
// FOR_VERIFICATION, not one-way. One generic status-change endpoint,
// same shape as every other module's changeXStatusSchema, rather than a
// separate /verify and /revert route for what's really the same write.
export const changeRemittanceRequestStatusSchema = z.object({
  toStatus: z.enum(REMITTANCE_STATUS_KEYS),
});

export type ChangeRemittanceRequestStatusInput = z.infer<typeof changeRemittanceRequestStatusSchema>;
