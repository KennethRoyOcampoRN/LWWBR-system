import { STOCK_CATEGORY_KEYS, STOCK_MOVEMENT_REASON_KEYS } from '@lwwbr/shared';
import { z } from 'zod';

export const createStockItemSchema = z.object({
  name: z.string().trim().min(1).max(200),
  category: z.enum(STOCK_CATEGORY_KEYS),
  unitOfMeasure: z.string().trim().min(1).max(50),
  reorderLevel: z.number().nonnegative(),
  // A starting balance, not a movement — same reasoning as
  // AmenityItem.totalQty being set directly at creation rather than
  // through amenity:request: there's nothing to "log" about establishing
  // a baseline count for a brand-new catalog row. Defaults to 0 (a new
  // item with nothing on the shelf yet, RECEIVE it in once real stock
  // arrives).
  initialQty: z.number().nonnegative().optional(),
});
export type CreateStockItemInput = z.infer<typeof createStockItemSchema>;

export const updateStockItemSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    category: z.enum(STOCK_CATEGORY_KEYS).optional(),
    unitOfMeasure: z.string().trim().min(1).max(50).optional(),
    reorderLevel: z.number().nonnegative().optional(),
    isActive: z.boolean().optional(),
  })
  .strict();
export type UpdateStockItemInput = z.infer<typeof updateStockItemSchema>;

export const listStockItemsQuerySchema = z.object({
  isActive: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
});
export type ListStockItemsQuery = z.infer<typeof listStockItemsQuerySchema>;

// `quantity`'s sign meaning depends on `reason`, validated in the
// service, not here (needs the reason alongside it, and zod's
// cross-field refine reads worse than a plain if-chain for a 3-way
// branch): RECEIVE/CONSUME take a positive magnitude ("how many did you
// receive/use"); ADJUST takes the signed correction directly ("+3" or
// "-3"), since a miscount can go either direction and there is no
// natural sign to imply.
export const createStockMovementSchema = z.object({
  reason: z.enum(STOCK_MOVEMENT_REASON_KEYS),
  quantity: z.number().refine((n) => n !== 0, 'quantity must not be zero'),
  note: z.string().trim().max(500).optional(),
});
export type CreateStockMovementInput = z.infer<typeof createStockMovementSchema>;

export const listStockMovementsQuerySchema = z.object({
  stockItemId: z.string().min(1).optional(),
});
export type ListStockMovementsQuery = z.infer<typeof listStockMovementsQuerySchema>;
