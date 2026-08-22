import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiRequestError } from '../src/lib/api.js';

function jsonResponse(status: number, body: unknown) {
  return Promise.resolve({
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body),
  } as Response);
}

describe('api client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('transparently refreshes and retries once on a 401, then returns the retried result', async () => {
    let usersCallCount = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/users')) {
        usersCallCount += 1;
        if (usersCallCount === 1) {
          return jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'expired' } });
        }
        return jsonResponse(200, { users: [{ id: 'u1' }] });
      }
      if (url.endsWith('/auth/refresh')) {
        return jsonResponse(200, { ok: true });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await api.get<{ users: unknown[] }>('/users');

    expect(result.users).toHaveLength(1);
    expect(usersCallCount).toBe(2);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/auth/refresh'), expect.anything());
  });

  it('surfaces the original 401 when the refresh attempt itself fails', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/users')) {
        return jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'expired' } });
      }
      if (url.endsWith('/auth/refresh')) {
        return jsonResponse(401, { error: { code: 'SESSION_EXPIRED', message: 'no valid refresh token' } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.get('/users')).rejects.toMatchObject(
      new ApiRequestError(401, 'UNAUTHENTICATED', 'expired'),
    );
    // Exactly one refresh attempt, one retry of the original request —
    // never a second refresh call chasing the retry's own 401.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not attempt a refresh loop when /auth/refresh itself 401s directly', async () => {
    const fetchMock = vi.fn(() =>
      jsonResponse(401, { error: { code: 'SESSION_EXPIRED', message: 'expired' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.post('/auth/refresh')).rejects.toBeInstanceOf(ApiRequestError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
