import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { registerSocketIoServer } from './adapters/realtime/index.js';
import { attachSocketIoServer } from './adapters/realtime/socketIoServer.js';
import { createApp } from './app.js';
import { getEnv } from './lib/env.js';

const env = getEnv();

// Client decision, 2026-10-27 (spec.md §13 decision 11): the self-hosted
// mini PC deployment serves the built SPA from this same process/port —
// see app.ts's serveStaticDir option. Off (undefined) by default so
// ordinary `npm run dev` (Vite serving the frontend separately, proxying
// /api/* here) is unaffected; the mini PC's own .env sets SERVE_WEB_DIST.
const app = createApp({
  serveStaticDir: env.SERVE_WEB_DIST ? resolve(import.meta.dirname, env.WEB_DIST_DIR) : undefined,
});

// Socket.IO needs a raw http.Server to attach to, which createApp()
// deliberately doesn't own — keeping that ownership here, not inside
// createApp() itself, is what lets createApp() stay a plain Express app
// that tests can exercise directly with no HTTP server involved at all.
const httpServer = createServer(app);

if (env.REALTIME_ADAPTER === 'socketio') {
  registerSocketIoServer(attachSocketIoServer(httpServer));
}

httpServer.listen(env.PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`api listening on http://localhost:${env.PORT}`);
});
