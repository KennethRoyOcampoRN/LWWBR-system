import type { PermissionKey, PermissionScope } from '@lwwbr/shared';
import { ApiError } from '../../lib/apiError.js';
import { prisma } from '../../lib/prisma.js';
import type { CreateRoleInput, UpdateRoleInput, UpdateRolePermissionsInput } from './schema.js';

export interface RoleSummary {
  id: string;
  key: string;
  label: string;
  description: string | null;
  isSystem: boolean;
  permissions: Partial<Record<PermissionKey, PermissionScope>>;
}

const roleInclude = { permissions: { where: { deletedAt: null }, include: { permission: true } } } as const;

function toSummary(role: {
  id: string;
  key: string;
  label: string;
  description: string | null;
  isSystem: boolean;
  permissions: { scope: string; permission: { key: string } }[];
}): RoleSummary {
  const permissions: Partial<Record<PermissionKey, PermissionScope>> = {};
  for (const grant of role.permissions) {
    permissions[grant.permission.key as PermissionKey] = grant.scope as PermissionScope;
  }
  return {
    id: role.id,
    key: role.key,
    label: role.label,
    description: role.description,
    isSystem: role.isSystem,
    permissions,
  };
}

export async function listRoles(): Promise<RoleSummary[]> {
  const roles = await prisma.role.findMany({
    where: { deletedAt: null },
    include: roleInclude,
    orderBy: { key: 'asc' },
  });
  return roles.map(toSummary);
}

export async function listPermissions(): Promise<{ key: string; group: string; description: string | null }[]> {
  const permissions = await prisma.permission.findMany({
    where: { deletedAt: null },
    orderBy: { key: 'asc' },
  });
  return permissions.map((p) => ({ key: p.key, group: p.group, description: p.description }));
}

export async function createRole(input: CreateRoleInput): Promise<RoleSummary> {
  const existing = await prisma.role.findFirst({ where: { key: input.key } });
  if (existing) {
    throw new ApiError(409, 'ROLE_KEY_TAKEN', `Role key "${input.key}" is already in use`);
  }
  const role = await prisma.role.create({
    data: {
      key: input.key,
      label: input.label,
      description: input.description ?? null,
      isSystem: false,
    },
    include: roleInclude,
  });
  return toSummary(role);
}

export async function updateRole(roleId: string, input: UpdateRoleInput): Promise<RoleSummary> {
  const existing = await prisma.role.findFirst({ where: { id: roleId, deletedAt: null } });
  if (!existing) {
    throw new ApiError(404, 'NOT_FOUND', 'Role not found');
  }
  const role = await prisma.role.update({
    where: { id: roleId },
    data: {
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
    },
    include: roleInclude,
  });
  return toSummary(role);
}

// Replaces the role's entire permission grant set in one transaction —
// same reasoning as users.updateUser's roleKeys handling: the admin UI
// always submits the full desired grant list, never a delta, so diffing
// add/remove would be needless complexity for no behavior difference.
export async function updateRolePermissions(
  roleId: string,
  input: UpdateRolePermissionsInput,
): Promise<RoleSummary> {
  const existing = await prisma.role.findFirst({ where: { id: roleId, deletedAt: null } });
  if (!existing) {
    throw new ApiError(404, 'NOT_FOUND', 'Role not found');
  }

  const permissionKeys = input.grants.map((grant) => grant.permissionKey);
  const permissions = await prisma.permission.findMany({ where: { key: { in: permissionKeys } } });
  const permissionIdByKey = new Map(permissions.map((p) => [p.key, p.id]));

  const rows = input.grants.map((grant) => {
    const permissionId = permissionIdByKey.get(grant.permissionKey);
    if (!permissionId) {
      throw new ApiError(422, 'VALIDATION_ERROR', `Unknown permission key: ${grant.permissionKey}`);
    }
    return { roleId, permissionId, scope: grant.scope };
  });

  await prisma.$transaction([
    prisma.rolePermission.deleteMany({ where: { roleId } }),
    ...(rows.length > 0 ? [prisma.rolePermission.createMany({ data: rows })] : []),
  ]);

  const role = await prisma.role.findFirstOrThrow({ where: { id: roleId }, include: roleInclude });
  return toSummary(role);
}
