import { getEffectivePermissions, type RoleKey } from '@lwwbr/shared';
import { ApiError } from '../../lib/apiError.js';
import { logAudit } from '../../lib/auditLog.js';
import { prisma } from '../../lib/prisma.js';
import { verifyPassword } from './passwords.js';
import {
  generateRefreshToken,
  hashRefreshToken,
  REFRESH_TOKEN_TTL_SECONDS,
  signAccessToken,
} from './tokens.js';

export interface RequestMeta {
  ip?: string | null;
  userAgent?: string | null;
}

export interface AuthenticatedUser {
  id: string;
  employeeCode: string;
  fullName: string;
  email: string | null;
  department: string;
  mustChangePassword: boolean;
  roles: RoleKey[];
  permissions: ReturnType<typeof getEffectivePermissions>;
}

function invalidCredentials(): ApiError {
  // Deliberately the same error for "no such employeeCode" and "wrong
  // password" — distinguishing them lets an attacker enumerate valid
  // employee codes.
  return new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid employee code or password');
}

async function loadAuthenticatedUser(userId: string): Promise<AuthenticatedUser> {
  const user = await prisma.user.findFirst({
    where: { id: userId, deletedAt: null },
    include: { roles: { where: { deletedAt: null }, include: { role: true } } },
  });
  if (!user || !user.isActive) {
    throw new ApiError(401, 'UNAUTHENTICATED', 'Not authenticated');
  }
  const roles = user.roles.map((userRole) => userRole.role.key as RoleKey);
  return {
    id: user.id,
    employeeCode: user.employeeCode,
    fullName: user.fullName,
    email: user.email,
    department: user.department,
    mustChangePassword: user.mustChangePassword,
    roles,
    permissions: getEffectivePermissions(roles),
  };
}

export interface LoginResult {
  user: AuthenticatedUser;
  accessToken: string;
  refreshToken: string;
}

// TOTP 2FA for OWNER/SYSTEM_ADMIN (spec §3.1.1) and login rate limiting /
// lockout land in a follow-up task — this is deliberately password-only
// for now. The insertion point for a TOTP challenge is right after the
// password check succeeds, before a session is created.
export async function login(
  employeeCode: string,
  password: string,
  meta: RequestMeta,
): Promise<LoginResult> {
  const user = await prisma.user.findFirst({
    where: { employeeCode, deletedAt: null },
    include: { roles: { where: { deletedAt: null }, include: { role: true } } },
  });

  if (!user || !user.isActive || !(await verifyPassword(user.passwordHash, password))) {
    await logAudit({
      actorId: user?.id ?? null,
      action: 'LOGIN_FAILURE',
      entity: 'User',
      // Fall back to the attempted employeeCode when no matching user
      // exists — AuditLog.entityId is required, and this is still useful
      // signal (repeated attempts against a code that doesn't exist).
      entityId: user?.id ?? employeeCode,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    throw invalidCredentials();
  }

  const refreshToken = generateRefreshToken();
  await prisma.session.create({
    data: {
      userId: user.id,
      refreshTokenHash: hashRefreshToken(refreshToken),
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000),
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
    },
  });
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await logAudit({
    actorId: user.id,
    action: 'LOGIN_SUCCESS',
    entity: 'User',
    entityId: user.id,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });

  const roles = user.roles.map((userRole) => userRole.role.key as RoleKey);
  return {
    user: {
      id: user.id,
      employeeCode: user.employeeCode,
      fullName: user.fullName,
      email: user.email,
      department: user.department,
      mustChangePassword: user.mustChangePassword,
      roles,
      permissions: getEffectivePermissions(roles),
    },
    accessToken: signAccessToken(user.id),
    refreshToken,
  };
}

// Reissues an access token from a still-valid refresh token. The refresh
// token itself is NOT rotated on every call — Session is a one-row-per-
// login-device model (spec §3.1.1's "sign out all other devices"), and
// rotating it on every silent renewal would either multiply session rows
// or require chaining them, both of which complicate that UX for no
// benefit here (the refresh token never leaves an httpOnly cookie, so
// it isn't exposed to the theft scenario rotation-with-reuse-detection
// defends against). It still has a fixed 7-day absolute lifetime and is
// fully revocable.
export async function refresh(refreshToken: string): Promise<{ accessToken: string }> {
  const session = await prisma.session.findFirst({
    where: {
      refreshTokenHash: hashRefreshToken(refreshToken),
      revokedAt: null,
      deletedAt: null,
    },
  });
  if (!session || session.expiresAt < new Date()) {
    throw new ApiError(401, 'SESSION_EXPIRED', 'Session expired or revoked — please log in again.');
  }
  return { accessToken: signAccessToken(session.userId) };
}

export async function logout(refreshToken: string): Promise<void> {
  await prisma.session.updateMany({
    where: { refreshTokenHash: hashRefreshToken(refreshToken), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function getMe(userId: string): Promise<AuthenticatedUser> {
  return loadAuthenticatedUser(userId);
}
