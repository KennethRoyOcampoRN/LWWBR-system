import { DEPARTMENT_KEYS, ROLE_KEYS } from '@lwwbr/shared';
import { z } from 'zod';

export const createUserSchema = z.object({
  employeeCode: z.string().trim().min(1).max(20),
  fullName: z.string().trim().min(1).max(200),
  email: z.string().trim().email().optional(),
  phone: z.string().trim().min(1).max(30).optional(),
  department: z.enum(DEPARTMENT_KEYS),
  roleKeys: z.array(z.enum(ROLE_KEYS)).min(1),
});

export const updateUserSchema = z.object({
  fullName: z.string().trim().min(1).max(200).optional(),
  email: z.string().trim().email().nullable().optional(),
  phone: z.string().trim().min(1).max(30).nullable().optional(),
  department: z.enum(DEPARTMENT_KEYS).optional(),
  isActive: z.boolean().optional(),
  roleKeys: z.array(z.enum(ROLE_KEYS)).min(1).optional(),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
