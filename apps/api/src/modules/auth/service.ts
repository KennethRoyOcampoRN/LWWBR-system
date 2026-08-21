import { getEffectivePermissions, type RoleKey } from '@lwwbr/shared';
import { ApiError } from '../../lib/apiError.js';
import { logAudit } from '../../lib/auditLog.js';
import { prisma } from '../../lib/prisma.js';
import { setRequestActorId } from '../../lib/requestContext.js';
import { assertNotLockedOrRateLimited, maybeLockAccount } from './loginThrottle.js';
import { verifyPassword } from './passwords.js';
import { requiresTotp } from './requiresTotp.js';
import {
  generateRefreshToken,
  hashRefreshToken,
  REFRESH_TOKEN_TTL_SECONDS,
  signAccessToken,
} from './tokens.js';
import { generateTotpSecret, totpProvisioningUri, verifyTotpCode } from './totp.js';

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

export interface LoginSuccess {
  status: 'success';
  user: AuthenticatedUser;
  accessToken: string;
  refreshToken: string;
}

// Returned instead of a session on an OWNER/SYSTEM_ADMIN account's first
// login — spec §3.1.1 requires TOTP for these roles, so enrollment has
// to happen somewhere. The secret is generated and persisted immediately
// (see login() below for why that's safe), and the caller must complete
// login again with a valid code from it before a session is issued —
// "an owner account cannot complete login without a TOTP code" is true
// even on the very first login.
export interface LoginTotpSetupRequired {
  status: 'totp_setup_required';
  provisioningUri: string;
}

export type LoginResult = LoginSuccess | LoginTotpSetupRequired;

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

export async function login(
  employeeCode: string,
  password: string,
  meta: RequestMeta,
  totpCode?: string,
): Promise<LoginResult> {
  const user = await prisma.user.findFirst({
    where: { employeeCode, deletedAt: null },
    include: { roles: { where: { deletedAt: null }, include: { role: true } } },
  });
  const accountKey = user?.id ?? employeeCode;

  await assertNotLockedOrRateLimited(accountKey, meta.ip);

  if (!user || !user.isActive || !(await verifyPassword(user.passwordHash, password))) {
    await logAudit({
      actorId: user?.id ?? null,
      action: 'LOGIN_FAILURE',
      entity: 'User',
      // Fall back to the attempted employeeCode when no matching user
      // exists — AuditLog.entityId is required, and this is still useful
      // signal (repeated attempts against a code that doesn't exist).
      entityId: accountKey,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    await maybeLockAccount(accountKey, meta);
    throw invalidCredentials();
  }

  // The user is now authenticated, even though no access token exists
  // yet — attribute the lastLoginAt update below (and anything else
  // this request does) to them, rather than leaving the audit
  // extension's actorId null for a write that plainly has an actor.
  setRequestActorId(user.id);

  const roles = user.roles.map((userRole) => userRole.role.key as RoleKey);

  if (requiresTotp(roles)) {
    if (!user.totpSecret) {
      // First login for a role that requires 2FA: generate and persist
      // a secret now. Safe to persist before confirmation — an
      // abandoned enrollment just means the next login attempt
      // regenerates and overwrites it, which is harmless (nothing was
      // ever issued against the old one).
      const secret = generateTotpSecret();
      await prisma.user.update({ where: { id: user.id }, data: { totpSecret: secret } });
      return { status: 'totp_setup_required', provisioningUri: totpProvisioningUri(secret, user.employeeCode) };
    }
    if (!totpCode) {
      // Password was correct — this isn't a failure, so it's neither
      // logged as one nor counted toward lockout/rate-limiting.
      throw new ApiError(401, 'TOTP_REQUIRED', 'Enter your authenticator code to finish signing in.');
    }
    if (!verifyTotpCode(user.totpSecret, totpCode)) {
      // A wrong code, unlike a missing one, is exactly the kind of
      // repeated-guessing this account's lockout exists to catch — a
      // 6-digit TOTP code is brute-forceable within its validity window
      // without this.
      await logAudit({
        actorId: user.id,
        action: 'LOGIN_FAILURE',
        entity: 'User',
        entityId: accountKey,
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      await maybeLockAccount(accountKey, meta);
      throw new ApiError(401, 'TOTP_INVALID', 'Invalid authenticator code.');
    }
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

  return {
    status: 'success',
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

export interface SessionSummary {
  id: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: Date;
  expiresAt: Date;
}

// Spec §3.1.1: "Session list and remote revocation in user settings —
// 'sign out all other devices'." Self-service only — a user manages
// their own device list. Never exposes refreshTokenHash/
// previousRefreshTokenHash.
export async function listSessions(userId: string): Promise<SessionSummary[]> {
  const sessions = await prisma.session.findMany({
    where: { userId, revokedAt: null, deletedAt: null, expiresAt: { gt: new Date() } },
    select: { id: true, ip: true, userAgent: true, createdAt: true, expiresAt: true },
    orderBy: { createdAt: 'desc' },
  });
  return sessions;
}

export async function revokeSession(userId: string, sessionId: string, meta: RequestMeta): Promise<void> {
  const session = await prisma.session.findFirst({
    where: { id: sessionId, userId, revokedAt: null, deletedAt: null },
  });
  if (!session) {
    throw new ApiError(404, 'NOT_FOUND', 'Session not found');
  }
  await prisma.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
  await logAudit({
    actorId: userId,
    action: 'SESSION_REVOKED',
    entity: 'Session',
    entityId: session.id,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
}
