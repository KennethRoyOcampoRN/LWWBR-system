// Vercel serverless entry point (spec §3.1, M7). An Express app instance
// is itself a valid (req, res) request handler, so no adapter library is
// needed. Not wired into a deployment yet — see spec §11 M0/M7.
import { createApp } from './app.js';

const app = createApp();

export default app;
