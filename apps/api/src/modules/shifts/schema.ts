import { DEPARTMENT_KEYS } from '@lwwbr/shared';
import { z } from 'zod';

export const createShiftSchema = z.object({
  userId: z.string().min(1),
  date: z.string().datetime(),
  startTime: z.string().datetime(),
  endTime: z.string().datetime(),
  department: z.enum(DEPARTMENT_KEYS),
  isReliever: z.boolean().optional(),
  note: z.string().trim().max(500).optional(),
});
export type CreateShiftInput = z.infer<typeof createShiftSchema>;

export const updateShiftSchema = z
  .object({
    date: z.string().datetime().optional(),
    startTime: z.string().datetime().optional(),
    endTime: z.string().datetime().optional(),
    department: z.enum(DEPARTMENT_KEYS).optional(),
    isReliever: z.boolean().optional(),
    note: z.string().trim().max(500).optional(),
  })
  .strict();
export type UpdateShiftInput = z.infer<typeof updateShiftSchema>;

export const listShiftsQuerySchema = z.object({
  userId: z.string().min(1).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});
export type ListShiftsQuery = z.infer<typeof listShiftsQuerySchema>;
