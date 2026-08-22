import { randomInt } from 'node:crypto';
import type { RoleKey } from '@lwwbr/shared';
import { ApiError } from '../../lib/apiError.js';
import { prisma } from '../../lib/prisma.js';
import { hashPassword } from '../auth/passwords.js';
import type { CreateUserInput, UpdateUserInput } from './schema.js';

export interface UserSummary {
  id: string;
  employeeCode: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  department: string;
  isActive: boolean;
  mustChangePassword: boolean;
  lastLoginAt: Date | null;
  roles: RoleKey[];
}

// Not cryptographically precious — this is a temporary password the admin
// hands to the new hire, who must change it on first login
// (mustChangePassword: true on both create and reset). Still drawn from
// crypto.randomInt rather than Math.random, since there's no reason not
// to.
const TEMP_PASSWORD_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

function generateTempPassword(): string {
  let password = '';
  for (let i = 0; i < 12; i++) {
    password += TEMP_PASSWORD_ALPHABET[randomInt(TEMP_PASSWORD_ALPHABET.length)];
  }
  return password;
}

function toSummary(user: {
  id: string;
  employeeCode: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  department: string;
  isActive: boolean;
  mustChangePassword: boolean;
  lastLoginAt: Date | null;
  roles: { role: { key: string } }[];
}): UserSummary {
  return {
    id: user.id,
    employeeCode: user.employeeCode,
    fullName: user.fullName,
    email: user.email,
    phone: user.phone,
    department: user.department,
    isActive: user.isActive,
    mustChangePassword: user.mustChangePassword,
    lastLoginAt: user.lastLoginAt,
    roles: user.roles.map((userRole) => userRole.role.key as RoleKey),
  };
}

const userInclude = { roles: { where: { deletedAt: null }, include: { role: true } } } as const;

export async function listUsers(): Promise<UserSummary[]> {
  const users = await prisma.user.findMany({
    where: { deletedAt: null },
    include: userInclude,
    orderBy: { employeeCode: 'asc' },
  });
  return users.map(toSummary);
}

async function resolveRoleIds(roleKeys: RoleKey[]): Promise<string[]> {
  const roles = await prisma.role.findMany({ where: { key: { in: roleKeys }, deletedAt: null } });
  const foundKeys = new Set(roles.map((role) => role.key));
  const missing = roleKeys.filter((key) => !foundKeys.has(key));
  if (missing.length > 0) {
    throw new ApiError(422, 'VALIDATION_ERROR', `Unknown role key(s): ${missing.join(', ')}`);
  }
  return roles.map((role) => role.id);
}

export interface CreatedUser {
  user: UserSummary;
  tempPassword: string;
}

export async function createUser(input: CreateUserInput): Promise<CreatedUser> {
  const existing = await prisma.user.findFirst({ where: { employeeCode: input.employeeCode } });
  if (existing) {
    throw new ApiError(409, 'EMPLOYEE_CODE_TAKEN', `Employee code "${input.employeeCode}" is already in use`);
  }

  const roleIds = await resolveRoleIds(input.roleKeys);
  const tempPassword = generateTempPassword();
  const passwordHash = await hashPassword(tempPassword);

  const user = await prisma.user.create({
    data: {
      employeeCode: input.employeeCode,
      fullName: input.fullName,
      email: input.email ?? null,
      phone: input.phone ?? null,
      department: input.department,
      passwordHash,
      mustChangePassword: true,
      roles: { create: roleIds.map((roleId) => ({ roleId })) },
    },
    include: userInclude,
  });

  return { user: toSummary(user), tempPassword };
}

export async function updateUser(userId: string, input: UpdateUserInput): Promise<UserSummary> {
  const existing = await prisma.user.findFirst({ where: { id: userId, deletedAt: null } });
  if (!existing) {
    throw new ApiError(404, 'NOT_FOUND', 'User not found');
  }

  if (input.roleKeys) {
    const roleIds = await resolveRoleIds(input.roleKeys);
    // Replace the whole assignment set in one transaction rather than
    // diffing add/remove — simpler, and the admin UI always submits the
    // full desired role list, never a delta.
    await prisma.$transaction([
      prisma.userRole.deleteMany({ where: { userId } }),
      prisma.userRole.createMany({ data: roleIds.map((roleId) => ({ userId, roleId })) }),
    ]);
  }

  const user = await prisma.user.update({
    where: { id: userId },
    data: {
      ...(input.fullName !== undefined ? { fullName: input.fullName } : {}),
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(input.phone !== undefined ? { phone: input.phone } : {}),
      ...(input.department !== undefined ? { department: input.department } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    },
    include: userInclude,
  });

  return toSummary(user);
}

export async function resetPassword(userId: string): Promise<{ tempPassword: string }> {
  const existing = await prisma.user.findFirst({ where: { id: userId, deletedAt: null } });
  if (!existing) {
    throw new ApiError(404, 'NOT_FOUND', 'User not found');
  }

  const tempPassword = generateTempPassword();
  const passwordHash = await hashPassword(tempPassword);
  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash, mustChangePassword: true },
  });
  // An admin-triggered reset is often a "this account may be compromised"
  // action — leaving old sessions alive would defeat the point of forcing
  // a new password.
  await prisma.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  return { tempPassword };
}
