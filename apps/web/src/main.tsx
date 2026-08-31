import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './index.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element not found');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Spec §11 M6: PWA manifest + install prompt + read-only offline cache of
// the last-known board. See public/sw.js for exactly what this caches
// (the app shell only, never /api/*) and why. `serviceWorker` doesn't
// exist in the vitest/jsdom test environment, so this guard also keeps
// the whole test suite from needing a mock for it.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((error) => {
      console.error('Service worker registration failed:', error);
    });
  });
}
