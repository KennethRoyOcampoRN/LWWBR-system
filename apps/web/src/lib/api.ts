// Spec §4.8 error shape: { error: { code, message, details? } }. Every
// call goes through here so that shape is unpacked into a typed error
// exactly once, not re-parsed at each call site.
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// Access tokens are short-lived (15 min, see apps/api's tokens.ts) by
// design — spec's session model expects the refresh token to renew them
// transparently. Until this existed, nothing on the frontend ever called
// /auth/refresh: any tab left open past 15 minutes would start failing
// every request with 401 and there was no recovery but a manual reload.
// One retry, only on a genuine 401, and only for requests that aren't
// themselves part of the auth flow (skipRefresh) — those must fail
// as-is or this would loop forever the moment the refresh token itself
// is also invalid/expired.
async function request<T>(path: string, init?: RequestInit, skipRefresh = false): Promise<T> {
  // A FormData body (file uploads) must never get an explicit
  // Content-Type — the browser sets its own `multipart/form-data;
  // boundary=...` when it serializes the body, and a hardcoded
  // 'application/json' here would make the server unable to parse it.
  const isFormData = init?.body instanceof FormData;
  const res = await fetch(`/api/v1${path}`, {
    ...init,
    credentials: 'include',
    headers: { ...(isFormData ? {} : { 'Content-Type': 'application/json' }), ...init?.headers },
  });

  if (res.status === 204) {
    return undefined as T;
  }

  const body: unknown = await res.json().catch(() => null);

  if (!res.ok) {
    if (res.status === 401 && !skipRefresh && path !== '/auth/refresh') {
      // Whether refresh succeeds or fails, retry the original request
      // exactly once with skipRefresh so it either succeeds against the
      // newly-set cookie, or fails again and falls into the normal
      // ApiRequestError path below — never a second refresh attempt.
      await request('/auth/refresh', { method: 'POST' }, true).catch(() => undefined);
      return request<T>(path, init, true);
    }

    const error = (body as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
    throw new ApiRequestError(
      res.status,
      error?.code ?? 'UNKNOWN_ERROR',
      error?.message ?? 'Request failed',
      error?.details,
    );
  }

  return body as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, data?: unknown) =>
    request<T>(path, { method: 'POST', body: data !== undefined ? JSON.stringify(data) : undefined }),
  patch: <T>(path: string, data?: unknown) =>
    request<T>(path, { method: 'PATCH', body: data !== undefined ? JSON.stringify(data) : undefined }),
  put: <T>(path: string, data?: unknown) =>
    request<T>(path, { method: 'PUT', body: data !== undefined ? JSON.stringify(data) : undefined }),
  // Multipart upload — used by POST /files. `field` matches the name
  // multer's .single() expects server-side ('file').
  upload: <T>(path: string, file: File, field = 'file') => {
    const formData = new FormData();
    formData.append(field, file);
    return request<T>(path, { method: 'POST', body: formData });
  },
};
