import { join } from 'node:path';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import helmet from 'helmet';
import { MulterError } from 'multer';
import { ZodError } from 'zod';
import { ApiError } from './lib/apiError.js';
import { forceHttps } from './lib/forceHttps.js';
import { attachRequestContext } from './lib/requestContextMiddleware.js';
import { amenitiesRouter } from './modules/amenities/router.js';
import { authRouter } from './modules/auth/router.js';
import { bookingsRouter } from './modules/bookings/router.js';
import { dtrRouter } from './modules/dtr/router.js';
import { filesRouter } from './modules/files/router.js';
import { fnbRouter } from './modules/fnb/router.js';
import { incidentsRouter } from './modules/incidents/router.js';
import { jobsRouter } from './modules/jobs/router.js';
import { notificationsRouter } from './modules/notifications/router.js';
import { quotationsRouter } from './modules/quotations/router.js';
import { remittancesRouter } from './modules/remittances/router.js';
import { reportsRouter } from './modules/reports/router.js';
import { restDayRouter } from './modules/restday/router.js';
import { rolesRouter } from './modules/roles/router.js';
import { shiftsRouter } from './modules/shifts/router.js';
import { stockRouter } from './modules/stock/router.js';
import { unitsRouter } from './modules/units/router.js';
import { usersRouter } from './modules/users/router.js';
import { workOrdersRouter } from './modules/workorders/router.js';
import { healthRouter } from './routes/health.js';

export interface CreateAppOptions {
  // Mounted after the real routers, before the 404 handler. Exists so
  // tests can exercise middleware like requirePermission through a real
  // route without it falling through to the catch-all 404 — production
  // never passes this.
  extraRouters?: RequestHandler[];
  // Client decision, 2026-10-27 (spec.md §13 decision 11): the self-
  // hosted mini PC deployment serves the built SPA from this same
  // process/port — there's no separate Netlify CDN anymore. Registered
  // after the /api/v1 routers (so nothing here can shadow an API route)
  // but before the catch-all 404 (so an unmatched non-API GET falls
  // through to index.html, the normal SPA-router pattern, rather than a
  // JSON 404). Absent for every other deployment and for tests.
  serveStaticDir?: string;
}

export function createApp(options: CreateAppOptions = {}) {
  const app = express();

  // Spec §3.1.1: HSTS + secure cookie flags + force HTTPS. helmet's
  // default already sets Strict-Transport-Security; the explicit config
  // here makes that a deliberate choice rather than an unexamined
  // default. maxAge is 180 days, a conventional HSTS duration.
  //
  // LAN_MODE (spec.md §13 decision 11) turns this off: HSTS is a promise
  // to the browser "always use HTTPS with this host from now on," which
  // is actively wrong to send on a deployment that's deliberately plain
  // HTTP — a browser that ever received it would then refuse to connect
  // over HTTP for the next 180 days. Reads process.env directly, not
  // through getEnv() — getEnv() validates the *entire* env schema
  // (DATABASE_URL, JWT_SECRET, ...) the moment it's first called, and
  // createApp() runs in every test in this suite, most of which have no
  // reason to ever provide real values for those; forcing that
  // validation here, unconditionally, broke hundreds of unrelated tests
  // the first time this was tried.
  const lanMode = process.env.LAN_MODE === 'true';
  app.use(helmet({ hsts: lanMode ? false : { maxAge: 15552000, includeSubDomains: true } }));
  app.use(forceHttps);
  app.use(cors({ credentials: true }));
  app.use(express.json());
  app.use(cookieParser());
  // Must run before any router — opens the per-request context the audit
  // Prisma extension (lib/prisma.ts) reads actor/ip/userAgent from.
  app.use(attachRequestContext);

  // Every route here reads live operational state (unit status, work
  // orders, sessions...) — Express sets an ETag on JSON bodies by
  // default, and with no Cache-Control at all a browser can legitimately
  // reuse a cached response under some conditions (a back/forward-cache
  // restore, a stale 304 revalidation) without the app ever getting a
  // chance to serve fresh data. There is no cacheable GET in this API;
  // `no-store` on everything under /api/v1 removes an entire class of
  // "why is the UI showing old data" reports before they start.
  app.use('/api/v1', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  app.use('/api/v1', healthRouter);
  app.use('/api/v1', authRouter);
  app.use('/api/v1', usersRouter);
  app.use('/api/v1', rolesRouter);
  app.use('/api/v1', unitsRouter);
  app.use('/api/v1', filesRouter);
  app.use('/api/v1', workOrdersRouter);
  app.use('/api/v1', notificationsRouter);
  app.use('/api/v1', bookingsRouter);
  app.use('/api/v1', amenitiesRouter);
  app.use('/api/v1', fnbRouter);
  app.use('/api/v1', reportsRouter);
  app.use('/api/v1', incidentsRouter);
  app.use('/api/v1', remittancesRouter);
  app.use('/api/v1', quotationsRouter);
  app.use('/api/v1', stockRouter);
  app.use('/api/v1', shiftsRouter);
  app.use('/api/v1', restDayRouter);
  app.use('/api/v1', dtrRouter);
  app.use('/api/v1', jobsRouter);

  for (const router of options.extraRouters ?? []) {
    app.use(router);
  }

  if (options.serveStaticDir) {
    const distDir = options.serveStaticDir;
    app.use(express.static(distDir));
    // SPA fallback — anything not already matched by /api/v1 or a static
    // asset above is a client-side route (React Router), so it gets
    // index.html and the browser's own router takes it from there.
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.sendFile(join(distDir, 'index.html'));
    });
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

    // Spec §7.2.1: "Max 10MB per file post-compression." multer throws
    // its own error class for this (and other upload-limit violations)
    // before our route handler ever runs, so it needs the same clean
    // 422 shape as every other validation failure rather than falling
    // through to the generic 500 below.
    if (err instanceof MulterError) {
      res.status(422).json({
        error: {
          code: err.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE' : 'UPLOAD_ERROR',
          message: err.message,
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
