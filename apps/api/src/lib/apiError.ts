// Spec §4.8: all API errors return { error: { code, message, details? } }
// and never leak stack traces in production. Thrown from route handlers
// and middleware; app.ts's error middleware turns it into that shape.
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
