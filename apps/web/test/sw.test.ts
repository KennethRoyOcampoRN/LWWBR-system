import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vm from 'node:vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The actual shipped file (apps/web/public/sw.js) is a classic — not
// module — service worker script, run by the browser in a
// ServiceWorkerGlobalScope that jsdom doesn't provide. Rather than
// duplicate its logic into a separately-tested helper module (which
// could then drift from what's actually served), this loads the real
// source and evaluates it inside a Node `vm` sandbox that stands in for
// `self` — same trick used to test service workers without a real
// browser. Every assertion below exercises the literal file that ships.
const swSource = readFileSync(join(__dirname, '../public/sw.js'), 'utf-8');

interface MockCache {
  put: ReturnType<typeof vi.fn>;
  match: ReturnType<typeof vi.fn>;
}

function loadServiceWorker() {
  const listeners: Record<string, ((event: unknown) => void)[]> = {};
  const cacheStore = new Map<string, MockCache>();

  const mockCache: MockCache = {
    put: vi.fn().mockResolvedValue(undefined),
    match: vi.fn().mockResolvedValue(undefined),
  };
  cacheStore.set('lwwbr-shell-v1', mockCache);

  const caches = {
    open: vi.fn((name: string) => {
      if (!cacheStore.has(name)) cacheStore.set(name, { put: vi.fn(), match: vi.fn() });
      return Promise.resolve(cacheStore.get(name));
    }),
    keys: vi.fn(() => Promise.resolve([...cacheStore.keys()])),
    delete: vi.fn((name: string) => {
      cacheStore.delete(name);
      return Promise.resolve(true);
    }),
    match: vi.fn((request: unknown) => mockCache.match(request)),
  };

  const clients = { claim: vi.fn().mockResolvedValue(undefined) };
  const skipWaiting = vi.fn();
  const fetchMock = vi.fn();

  const sandbox: Record<string, unknown> = {
    caches,
    clients,
    skipWaiting,
    fetch: fetchMock,
    URL,
    console,
    location: { origin: 'https://lwwbr.example' },
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      (listeners[type] ??= []).push(handler);
    },
  };
  sandbox.self = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(swSource, sandbox);

  return { listeners, caches, clients, skipWaiting, fetchMock, mockCache };
}

function mockRequest(url: string, method = 'GET') {
  return { url, method };
}

function mockResponse(ok: boolean, extra: Record<string, unknown> = {}) {
  return { ok, clone: vi.fn(() => ({ ok, ...extra })), ...extra };
}

describe('service worker (public/sw.js)', () => {
  let sw: ReturnType<typeof loadServiceWorker>;

  beforeEach(() => {
    sw = loadServiceWorker();
  });

  it('calls skipWaiting on install so the new worker activates immediately', () => {
    const installHandlers = sw.listeners['install'];
    expect(installHandlers).toHaveLength(1);
    installHandlers![0]!({});
    expect(sw.skipWaiting).toHaveBeenCalledTimes(1);
  });

  it('on activate, deletes every cache except the current CACHE_NAME and claims clients', async () => {
    sw.caches.keys.mockResolvedValueOnce(['lwwbr-shell-v1', 'lwwbr-shell-v0-stale']);
    let waitUntilPromise: Promise<unknown> = Promise.resolve();
    const event = { waitUntil: (p: Promise<unknown>) => (waitUntilPromise = p) };

    sw.listeners['activate']![0]!(event);
    await waitUntilPromise;

    expect(sw.caches.delete).toHaveBeenCalledWith('lwwbr-shell-v0-stale');
    expect(sw.caches.delete).not.toHaveBeenCalledWith('lwwbr-shell-v1');
    expect(sw.clients.claim).toHaveBeenCalledTimes(1);
  });

  it('caches a successful same-origin, non-API GET response and returns it', async () => {
    const response = mockResponse(true);
    sw.fetchMock.mockResolvedValueOnce(response);
    const request = mockRequest('https://lwwbr.example/index.html');

    let respondWithPromise: Promise<unknown> | undefined;
    const event = { request, respondWith: (p: Promise<unknown>) => (respondWithPromise = p) };
    sw.listeners['fetch']![0]!(event);

    expect(respondWithPromise).toBeDefined();
    const result = await respondWithPromise;
    expect(result).toBe(response);
    // Give the fire-and-forget caches.open().then(cache.put(...)) chain
    // a tick to run — it's not awaited by the returned response promise.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sw.mockCache.put).toHaveBeenCalledWith(request, expect.objectContaining({ ok: true }));
  });

  it('does NOT cache a non-ok response (e.g. a 404 for a missing asset)', async () => {
    const response = mockResponse(false);
    sw.fetchMock.mockResolvedValueOnce(response);
    const request = mockRequest('https://lwwbr.example/missing.js');

    let respondWithPromise: Promise<unknown> | undefined;
    sw.listeners['fetch']![0]!({ request, respondWith: (p: Promise<unknown>) => (respondWithPromise = p) });
    await respondWithPromise;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sw.mockCache.put).not.toHaveBeenCalled();
  });

  it('falls back to the cached copy of the request when the network fetch fails (offline)', async () => {
    sw.fetchMock.mockRejectedValueOnce(new Error('offline'));
    const request = mockRequest('https://lwwbr.example/units');
    const cachedResponse = mockResponse(true);
    sw.mockCache.match.mockImplementation((req: unknown) => (req === request ? Promise.resolve(cachedResponse) : Promise.resolve(undefined)));

    let respondWithPromise: Promise<unknown> | undefined;
    sw.listeners['fetch']![0]!({ request, respondWith: (p: Promise<unknown>) => (respondWithPromise = p) });
    const result = await respondWithPromise;

    expect(result).toBe(cachedResponse);
  });

  it('falls back to the cached index.html when offline and the exact request was never cached (deep link)', async () => {
    sw.fetchMock.mockRejectedValueOnce(new Error('offline'));
    const request = mockRequest('https://lwwbr.example/work-orders');
    const shellFallback = mockResponse(true);
    sw.mockCache.match.mockImplementation((req: unknown) => {
      if (req === request) return Promise.resolve(undefined);
      if (req === '/index.html') return Promise.resolve(shellFallback);
      return Promise.resolve(undefined);
    });

    let respondWithPromise: Promise<unknown> | undefined;
    sw.listeners['fetch']![0]!({ request, respondWith: (p: Promise<unknown>) => (respondWithPromise = p) });
    const result = await respondWithPromise;

    expect(result).toBe(shellFallback);
  });

  it('bypasses (never calls respondWith) a request under /api/ — the live-data path stays untouched', () => {
    const request = mockRequest('https://lwwbr.example/api/v1/units/dashboard');
    const respondWith = vi.fn();
    sw.listeners['fetch']![0]!({ request, respondWith });
    expect(respondWith).not.toHaveBeenCalled();
    expect(sw.fetchMock).not.toHaveBeenCalled();
  });

  it('bypasses a cross-origin request', () => {
    const request = mockRequest('https://supabase.example/realtime');
    const respondWith = vi.fn();
    sw.listeners['fetch']![0]!({ request, respondWith });
    expect(respondWith).not.toHaveBeenCalled();
  });

  it('bypasses a non-GET request (never caches a write)', () => {
    const request = mockRequest('https://lwwbr.example/some-path', 'POST');
    const respondWith = vi.fn();
    sw.listeners['fetch']![0]!({ request, respondWith });
    expect(respondWith).not.toHaveBeenCalled();
  });
});
