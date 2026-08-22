import { PERMISSION_KEYS, PERMISSION_SCOPES } from '@lwwbr/shared';
import { z } from 'zod';

// Custom roles (beyond the 14 seeded ones) key themselves the same way —
// upper-snake-case, matching the style ROLE_KEYS already uses — since the
// key is what shows up everywhere a role is referenced in code/audit logs.
const roleKeyPattern = /^[A-Z][A-Z0-9_]{1,49}$/;

export const createRoleSchema = z.object({
  key: z.string().regex(roleKeyPattern, 'Role key must be UPPER_SNAKE_CASE'),
  label: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).optional(),
});

export const updateRoleSchema = z.object({
  label: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(1000).nullable().optional(),
});

export const updateRolePermissionsSchema = z.object({
  grants: z
    .array(
      z.object({
        permissionKey: z.enum(PERMISSION_KEYS),
        scope: z.enum(PERMISSION_SCOPES),
      }),
    )
    .default([]),
});

export type CreateRoleInput = z.infer<typeof createRoleSchema>;
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;
export type UpdateRolePermissionsInput = z.infer<typeof updateRolePermissionsSchema>;
