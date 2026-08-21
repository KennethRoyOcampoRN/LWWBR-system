// Augments Express's Request with the fields requireAuth attaches.
import type {} from 'express';

declare global {
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

export {};
