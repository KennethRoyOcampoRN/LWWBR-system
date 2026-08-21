import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { ApiError } from '../../lib/apiError.js';
import { setAccessCookie, setRefreshCookie, clearAuthCookies, getRefreshCookie } from './cookies.js';
import { requireAuth } from './middleware.js';
import { loginSchema } from './schema.js';
import { getMe, login, logout, refresh } from './service.js';

export const authRouter = Router();

authRouter.post(
  '/auth/login',
  asyncHandler(async (req, res) => {
    const body = loginSchema.parse(req.body);
    const result = await login(body.employeeCode, body.password, {
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    });
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
