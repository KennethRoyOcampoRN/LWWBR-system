import { UNIT_STATUS_KEYS } from '@lwwbr/shared';
import { z } from 'zod';

const UNIT_KINDS = ['ROOM', 'COTTAGE', 'COMMON_AREA', 'FACILITY'] as const;

export const createUnitTypeSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  defaultCapacity: z.number().int().positive(),
  baseRate: z.number().nonnegative(),
  dayTourRate: z.number().nonnegative().optional(),
  extraPersonRate: z.number().nonnegative().optional(),
  colorHex: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  sortOrder: z.number().int().optional(),
});

export const updateUnitTypeSchema = createUnitTypeSchema.partial().extend({
  isActive: z.boolean().optional(),
});

export const createUnitSchema = z.object({
  code: z.string().trim().min(1).max(20),
  name: z.string().trim().min(1).max(200),
  unitTypeId: z.string().min(1),
  type: z.enum(UNIT_KINDS),
  capacity: z.number().int().positive().optional(),
  floor: z.string().trim().max(50).optional(),
  notes: z.string().trim().max(2000).optional(),
  sortOrder: z.number().int().optional(),
});

export const updateUnitSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  unitTypeId: z.string().min(1).optional(),
  type: z.enum(UNIT_KINDS).optional(),
  capacity: z.number().int().positive().optional(),
  floor: z.string().trim().max(50).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

export const changeUnitStatusSchema = z.object({
  toStatus: z.enum(UNIT_STATUS_KEYS),
  note: z.string().trim().max(2000).optional(),
  version: z.number().int().nonnegative(),
});

// Forced status correction (client decision, 2026-08-22): jumps a unit
// directly to any of the 8 statuses, bypassing the §7.1 transition table
// entirely. The note is mandatory here — unlike changeUnitStatusSchema's
// optional note — because this action exists specifically to explain why
// the system's status didn't match reality.
export const forceUnitStatusSchema = z.object({
  toStatus: z.enum(UNIT_STATUS_KEYS),
  note: z.string().trim().min(1, 'A note is required when forcing a status correction'),
  version: z.number().int().nonnegative(),
});

export type CreateUnitTypeInput = z.infer<typeof createUnitTypeSchema>;
export type UpdateUnitTypeInput = z.infer<typeof updateUnitTypeSchema>;
export type CreateUnitInput = z.infer<typeof createUnitSchema>;
export type UpdateUnitInput = z.infer<typeof updateUnitSchema>;
export type ChangeUnitStatusInput = z.infer<typeof changeUnitStatusSchema>;
export type ForceUnitStatusInput = z.infer<typeof forceUnitStatusSchema>;
