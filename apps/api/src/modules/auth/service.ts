import { getEffectivePermissions, type RoleKey } from '@lwwbr/shared';
import { ApiError } from '../../lib/apiError.js';
import { logAudit } from '../../lib/auditLog.js';
import { prisma } from '../../lib/prisma.js';
import { setRequestActorId } from '../../lib/requestContext.js';
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

  // The user is now authenticated, even though no access token exists
  // yet — attribute the lastLoginAt update below (and anything else
  // this request does) to them, rather than leaving the audit
  // extension's actorId null for a write that plainly has an actor.
  setRequestActorId(user.id);

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

// Reissues an access token AND rotates the refresh token, while keeping
// Session as a one-row-per-login-device model (spec §3.1.1's "sign out
// all other devices" needs exactly that — one row to list, one row to
// revoke). Rotation moves within the same row rather than creating a new
// one: the row's current refreshTokenHash becomes previousRefreshTokenHash,
// and the newly issued token's hash becomes the new current one.
//
// This is what makes reuse detection possible: if a request presents a
// hash matching a row's *previous* hash rather than its current one, that
// token was already rotated past by the legitimate client — someone else
// is replaying a stolen refresh token. Treat that as a compromise signal:
// revoke the session immediately (forcing that device to log in again)
// and audit it distinctly, rather than silently accepting or silently
// rejecting it as if it were just an expired token.
export async function refresh(
  refreshToken: string,
  meta: RequestMeta = {},
): Promise<{ accessToken: string; refreshToken: string }> {
  const incomingHash = hashRefreshToken(refreshToken);

  const currentMatch = await prisma.session.findFirst({
    where: { refreshTokenHash: incomingHash, revokedAt: null, deletedAt: null },
  });
  if (currentMatch) {
    if (currentMatch.expiresAt < new Date()) {
      throw new ApiError(401, 'SESSION_EXPIRED', 'Session expired or revoked — please log in again.');
    }
    const newRefreshToken = generateRefreshToken();
    await prisma.session.update({
      where: { id: currentMatch.id },
      data: {
        previousRefreshTokenHash: currentMatch.refreshTokenHash,
        refreshTokenHash: hashRefreshToken(newRefreshToken),
      },
    });
    return { accessToken: signAccessToken(currentMatch.userId), refreshToken: newRefreshToken };
  }

  const reusedMatch = await prisma.session.findFirst({
    where: { previousRefreshTokenHash: incomingHash, revokedAt: null, deletedAt: null },
  });
  if (reusedMatch) {
    await prisma.session.update({ where: { id: reusedMatch.id }, data: { revokedAt: new Date() } });
    await logAudit({
      actorId: reusedMatch.userId,
      action: 'REFRESH_TOKEN_REUSE_DETECTED',
      entity: 'Session',
      entityId: reusedMatch.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  }

  throw new ApiError(401, 'SESSION_EXPIRED', 'Session expired or revoked — please log in again.');
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
