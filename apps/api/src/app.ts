import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { healthRouter } from './routes/health.js';

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors({ credentials: true }));
  app.use(express.json());
  app.use(cookieParser());

  app.use('/api/v1', healthRouter);

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });

  // Spec §4.8: all API errors return { error: { code, message, details? } }
  // and never leak stack traces in production.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const isProd = process.env.NODE_ENV === 'production';
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
