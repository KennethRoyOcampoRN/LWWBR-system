import { AMENITY_CATEGORY_KEYS, AMENITY_REQUEST_STATUS_KEYS } from '@lwwbr/shared';
import { z } from 'zod';

export const createAmenityItemSchema = z.object({
  name: z.string().trim().min(1).max(200),
  category: z.enum(AMENITY_CATEGORY_KEYS),
  assetTag: z.string().trim().max(100).optional(),
  totalQty: z.number().int().positive(),
  condition: z.string().trim().min(1).max(200),
  requiresDeposit: z.boolean().optional(),
  depositAmount: z.number().nonnegative().optional(),
});

export const updateAmenityItemSchema = createAmenityItemSchema.partial().extend({
  isActive: z.boolean().optional(),
});

export type CreateAmenityItemInput = z.infer<typeof createAmenityItemSchema>;
export type UpdateAmenityItemInput = z.infer<typeof updateAmenityItemSchema>;

export const createAmenityRequestSchema = z.object({
  amenityItemId: z.string().min(1),
  bookingId: z.string().min(1).optional(),
  unitId: z.string().min(1).optional(),
  qty: z.number().int().positive(),
  notes: z.string().trim().max(2000).optional(),
});

export const listAmenityRequestsQuerySchema = z.object({
  status: z.enum(AMENITY_REQUEST_STATUS_KEYS).optional(),
  amenityItemId: z.string().min(1).optional(),
});

// One generic status-change endpoint, same shape as work orders'
// changeWorkOrderStatusSchema — which fields apply depends on toStatus,
// validated in the service layer (dueBackAt/depositCollected only make
// sense moving to ISSUED; conditionOnReturn only for RETURNED/
// LOST_DAMAGED). depositCollected is a plain boolean confirmation, never
// a recorded payment amount — see service.ts's own comment on the
// "monitoring, not transactions" scope decision this reflects.
export const changeAmenityRequestStatusSchema = z.object({
  toStatus: z.enum(AMENITY_REQUEST_STATUS_KEYS),
  dueBackAt: z.string().datetime().optional(),
  depositCollected: z.boolean().optional(),
  conditionOnReturn: z.string().trim().max(500).optional(),
  notes: z.string().trim().max(2000).optional(),
});

export type CreateAmenityRequestInput = z.infer<typeof createAmenityRequestSchema>;
export type ListAmenityRequestsQuery = z.infer<typeof listAmenityRequestsQuerySchema>;
export type ChangeAmenityRequestStatusInput = z.infer<typeof changeAmenityRequestStatusSchema>;
