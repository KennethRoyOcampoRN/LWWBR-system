// Netlify Function entry point (spec §3.1, M7). Wraps the Express app with
// serverless-http so it can run as a single Netlify Function; netlify.toml
// redirects /api/* here. Not deployed yet — see spec §11 M0/M7.
import serverless from 'serverless-http';
import { createApp } from '../../apps/api/src/app.js';

const app = createApp();

export const handler = serverless(app);
