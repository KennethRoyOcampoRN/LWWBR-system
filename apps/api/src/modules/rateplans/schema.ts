import { z } from 'zod';

// Spec.md §13 decision 29/§13.3 (2026-11-15): named rate plans the
// cashier explicitly chooses at billing time, replacing the never-built
// RateRule design. startDate/endDate/weekdayMask are a suggestion
// mechanism only (see service.ts's suggestRatePlanForBooking) — nothing
// here evaluates them against a stay to decide what the guest pays, so
// all three stay nullable rather than required together.
export const createRatePlanSchema = z.object({
  name: z.string().trim().min(1).max(100),
  startDate: z.string().date().optional(),
  endDate: z.string().date().optional(),
  // bit i = weekday i (Sun=0..Sat=6); 127 = every day. Suggestion input
  // only — see the model comment in schema.prisma.
  weekdayMask: z.number().int().min(0).max(127).optional(),
});
export type CreateRatePlanInput = z.infer<typeof createRatePlanSchema>;

export const updateRatePlanSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  // null explicitly clears a previously-set suggestion field; undefined
  // leaves it untouched — same optional-vs-null distinction this
  // codebase's other partial-update schemas already use.
  startDate: z.string().date().nullable().optional(),
  endDate: z.string().date().nullable().optional(),
  weekdayMask: z.number().int().min(0).max(127).nullable().optional(),
  isActive: z.boolean().optional(),
});
export type UpdateRatePlanInput = z.infer<typeof updateRatePlanSchema>;

export const setRatePlanRateSchema = z.object({
  rate: z.number().nonnegative(),
});
export type SetRatePlanRateInput = z.infer<typeof setRatePlanRateSchema>;
