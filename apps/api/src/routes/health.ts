import { Router } from 'express';
import { resolvedRealtimeAdapterName } from '../adapters/realtime/index.js';
import { resolvedStorageAdapterName } from '../adapters/storage/index.js';

export const healthRouter = Router();

// Deliberately does not touch the database or network — this reports
// which adapters *would* be used, not whether they're reachable. Adapter
// round-trip verification is a separate, explicit test (see
// test/adapters/*.roundtrip.test.ts) that requires a running local
// Supabase stack.
healthRouter.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    region: process.env.VERCEL_REGION ?? 'local',
    adapters: {
      realtime: resolvedRealtimeAdapterName(),
      storage: resolvedStorageAdapterName(),
    },
    timestamp: new Date().toISOString(),
  });
});
