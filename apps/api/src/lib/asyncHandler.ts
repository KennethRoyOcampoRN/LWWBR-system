import type { NextFunction, Request, RequestHandler, Response } from 'express';

// Express 4 does not catch rejected promises from async handlers on its
// own — an unhandled rejection would hang the request instead of reaching
// the error middleware. Wrap every async route handler with this.
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
