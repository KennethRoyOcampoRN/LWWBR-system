import { FNB_ORDER_STATUS_KEYS, FNB_ORDER_TYPE_KEYS, FNB_SETTLEMENT_KEYS } from '@lwwbr/shared';
import { z } from 'zod';

export const createMenuItemSchema = z.object({
  name: z.string().trim().min(1).max(200),
  category: z.string().trim().min(1).max(100),
  price: z.number().nonnegative(),
  isAvailable: z.boolean().optional(),
  prepMinutes: z.number().int().positive().optional(),
  sortOrder: z.number().int().optional(),
});

export const updateMenuItemSchema = createMenuItemSchema.partial();

export type CreateMenuItemInput = z.infer<typeof createMenuItemSchema>;
export type UpdateMenuItemInput = z.infer<typeof updateMenuItemSchema>;

const fnbOrderLineSchema = z.object({
  menuItemId: z.string().min(1),
  qty: z.number().int().positive(),
  notes: z.string().trim().max(500).optional(),
});

// settlement (PAY_NOW/CHARGE_TO_ROOM) is an informational classification
// only — see service.ts's own comment on the monitoring-not-transactions
// scope decision (client confirmed 2026-08-24) — no Payment/FolioCharge
// is ever created from it. The one real validation CHARGE_TO_ROOM still
// needs (the order's unit must actually be occupied) requires a DB
// lookup, so it's enforced in the service, not here.
export const createFnbOrderSchema = z
  .object({
    type: z.enum(FNB_ORDER_TYPE_KEYS),
    settlement: z.enum(FNB_SETTLEMENT_KEYS),
    unitId: z.string().min(1).optional(),
    bookingId: z.string().min(1).optional(),
    guestName: z.string().trim().max(200).optional(),
    scheduledFor: z.string().datetime().optional(),
    notes: z.string().trim().max(2000).optional(),
    lines: z.array(fnbOrderLineSchema).min(1),
  })
  .refine((data) => data.type !== 'ADVANCE_ORDER' || data.scheduledFor !== undefined, {
    message: 'scheduledFor is required for an ADVANCE_ORDER',
    path: ['scheduledFor'],
  });

export const listFnbOrdersQuerySchema = z.object({
  status: z.enum(FNB_ORDER_STATUS_KEYS).optional(),
  // The kitchen board view: active statuses only, and an ADVANCE_ORDER
  // stays hidden until its lead-time window opens (spec §7.3) — see
  // listFnbOrders in service.ts.
  boardOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  // Real gap found live-testing, 2026-08-25: once an order left the
  // active kanban board, its full detail (items, cancellation reason,
  // timestamps) was only visible by digging into Supabase directly.
  // The history view: SERVED/CANCELLED only, newest first, capped — see
  // listFnbOrders in service.ts. `status` still narrows further within
  // this set when given (e.g. history=true&status=CANCELLED).
  history: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

// Client decision, 2026-08-25: cancelling an order requires a reason,
// same as forceUnitStatus's mandatory note for a forced status
// correction — enforced here as a conditional-required field rather than
// left to the service layer, same pattern as createFnbOrderSchema's own
// scheduledFor-for-ADVANCE_ORDER refine above.
export const changeFnbOrderStatusSchema = z
  .object({
    toStatus: z.enum(FNB_ORDER_STATUS_KEYS),
    cancelReason: z.string().trim().min(1).max(500).optional(),
  })
  .refine((data) => data.toStatus !== 'CANCELLED' || data.cancelReason !== undefined, {
    message: 'cancelReason is required to cancel an order',
    path: ['cancelReason'],
  });

export type CreateFnbOrderInput = z.infer<typeof createFnbOrderSchema>;
export type ListFnbOrdersQuery = z.infer<typeof listFnbOrdersQuerySchema>;
export type ChangeFnbOrderStatusInput = z.infer<typeof changeFnbOrderStatusSchema>;
