import { z } from 'zod';

export const loginSchema = z.object({
  employeeCode: z.string().min(1, 'employeeCode is required'),
  password: z.string().min(1, 'password is required'),
  // Only required for OWNER/SYSTEM_ADMIN once they've enrolled — see
  // service.ts login(). A 6-digit TOTP code; optional here because most
  // logins never need it.
  totpCode: z.string().min(1).optional(),
});

export type LoginInput = z.infer<typeof loginSchema>;

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'currentPassword is required'),
  newPassword: z.string().min(8, 'newPassword must be at least 8 characters'),
});

export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
