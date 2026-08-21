import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { ApiError } from '../../lib/apiError.js';
import { setAccessCookie, setRefreshCookie, clearAuthCookies, getRefreshCookie } from './cookies.js';
import { requireAuth } from './middleware.js';
import { loginSchema } from './schema.js';
import { getMe, listSessions, login, logout, refresh, revokeSession } from './service.js';

export const authRouter = Router();

authRouter.post(
  '/auth/login',
  asyncHandler(async (req, res) => {
    const body = loginSchema.parse(req.body);
    const meta = { ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null };
    const result = await login(body.employeeCode, body.password, meta, body.totpCode);

    if (result.status === 'totp_setup_required') {
      // No session yet — spec §3.1.1: an OWNER/SYSTEM_ADMIN account
      // can't complete login without a TOTP code, including on its
      // first-ever login.
      res.status(200).json({ totpSetupRequired: true, provisioningUri: result.provisioningUri });
      return;
    }

    setAccessCookie(res, result.accessToken);
    setRefreshCookie(res, result.refreshToken);
    res.status(200).json({ user: result.user });
  }),
);

authRouter.post(
  '/auth/refresh',
  asyncHandler(async (req, res) => {
    const refreshToken = getRefreshCookie(req);
    if (!refreshToken) {
      throw new ApiError(401, 'UNAUTHENTICATED', 'No refresh token present');
    }
    const result = await refresh(refreshToken, {
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    });
    setAccessCookie(res, result.accessToken);
    setRefreshCookie(res, result.refreshToken);
    res.status(200).json({ ok: true });
  }),
);

authRouter.post(
  '/auth/logout',
  asyncHandler(async (req, res) => {
    const refreshToken = getRefreshCookie(req);
    if (refreshToken) {
      await logout(refreshToken);
    }
    clearAuthCookies(res);
    res.status(204).send();
  }),
);

authRouter.get(
  '/auth/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await getMe(req.userId as string);
    res.status(200).json({ user });
  }),
);

// Spec §3.1.1: "Session list and remote revocation in user settings —
// 'sign out all other devices'." Self-service: a user manages only their
// own sessions, never another user's.
authRouter.get(
  '/auth/sessions',
  requireAuth,
  asyncHandler(async (req, res) => {
    const sessions = await listSessions(req.userId as string);
    res.status(200).json({ sessions });
  }),
);

authRouter.post(
  '/auth/sessions/:id/revoke',
  requireAuth,
  asyncHandler(async (req, res) => {
    await revokeSession(req.userId as string, req.params.id as string, {
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    });
    res.status(204).send();
  }),
);
