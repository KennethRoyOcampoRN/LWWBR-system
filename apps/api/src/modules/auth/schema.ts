import { z } from 'zod';

export const loginSchema = z.object({
  employeeCode: z.string().min(1, 'employeeCode is required'),
  password: z.string().min(1, 'password is required'),
});

export type LoginInput = z.infer<typeof loginSchema>;
