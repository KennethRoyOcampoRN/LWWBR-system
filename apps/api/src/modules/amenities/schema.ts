import { AMENITY_CATEGORY_KEYS } from '@lwwbr/shared';
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
