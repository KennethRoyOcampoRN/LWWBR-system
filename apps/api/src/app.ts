import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import helmet from 'helmet';
import { ZodError } from 'zod';
import { ApiError } from './lib/apiError.js';
import { forceHttps } from './lib/forceHttps.js';
import { attachRequestContext } from './lib/requestContextMiddleware.js';
import { authRouter } from './modules/auth/router.js';
import { rolesRouter } from './modules/roles/router.js';
import { usersRouter } from './modules/users/router.js';
import { healthRouter } from './routes/health.js';

export interface CreateAppOptions {
  // Mounted after the real routers, before the 404 handler. Exists so
  // tests can exercise middleware like requirePermission through a real
  // route without it falling through to the catch-all 404 — production
  // never passes this.
  extraRouters?: RequestHandler[];
}

export function createApp(options: CreateAppOptions = {}) {
  const app = express();

  // Spec §3.1.1: HSTS + secure cookie flags + force HTTPS. helmet's
  // default already sets Strict-Transport-Security; the explicit config
  // here makes that a deliberate choice rather than an unexamined
  // default. maxAge is 180 days, a conventional HSTS duration.
  app.use(helmet({ hsts: { maxAge: 15552000, includeSubDomains: true } }));
  app.use(forceHttps);
  app.use(cors({ credentials: true }));
  app.use(express.json());
  app.use(cookieParser());
  // Must run before any router — opens the per-request context the audit
  // Prisma extension (lib/prisma.ts) reads actor/ip/userAgent from.
  app.use(attachRequestContext);

  app.use('/api/v1', healthRouter);
  app.use('/api/v1', authRouter);
  app.use('/api/v1', usersRouter);
  app.use('/api/v1', rolesRouter);

  for (const router of options.extraRouters ?? []) {
    app.use(router);
  }

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });

  // Spec §4.8: all API errors return { error: { code, message, details? } }
  // and never leak stack traces in production.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const isProd = process.env.NODE_ENV === 'production';

    if (err instanceof ApiError) {
      res.status(err.status).json({
        error: {
          code: err.code,
          message: err.message,
          ...(err.details !== undefined ? { details: err.details } : {}),
        },
      });
      return;
    }

    if (err instanceof ZodError) {
      res.status(422).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid request body',
          details: err.issues,
        },
      });
      return;
    }

    const message = err instanceof Error ? err.message : 'Internal server error';
    if (!isProd) {
      console.error(err);
    }
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: isProd ? 'Internal server error' : message,
      },
    });
  });

  return app;
}
