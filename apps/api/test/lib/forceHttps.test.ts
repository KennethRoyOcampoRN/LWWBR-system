import type { Request, Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forceHttps } from '../../src/lib/forceHttps.js';

function fakeReq(overrides: Partial<Request> = {}): Request {
  return { headers: {}, secure: false, ...overrides } as Request;
}

describe('forceHttps', () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it('never blocks outside production, even over plain http', () => {
    process.env.NODE_ENV = 'development';
    const next = vi.fn();
    forceHttps(fakeReq({ secure: false, headers: {} }), {} as Response, next);
    expect(next).toHaveBeenCalledOnce();
  });

  describe('in production', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'production';
    });

    it('rejects a plain HTTP request', () => {
      const next = vi.fn();
      expect(() => forceHttps(fakeReq({ secure: false, headers: {} }), {} as Response, next)).toThrowError(
        expect.objectContaining({ status: 403, code: 'HTTPS_REQUIRED' }),
      );
      expect(next).not.toHaveBeenCalled();
    });

    it('allows a request Express itself sees as secure', () => {
      const next = vi.fn();
      forceHttps(fakeReq({ secure: true, headers: {} }), {} as Response, next);
      expect(next).toHaveBeenCalledOnce();
    });

    it('allows a request behind a proxy that sets x-forwarded-proto: https', () => {
      const next = vi.fn();
      forceHttps(fakeReq({ secure: false, headers: { 'x-forwarded-proto': 'https' } }), {} as Response, next);
      expect(next).toHaveBeenCalledOnce();
    });

    it('rejects x-forwarded-proto: http even if some other header looks secure', () => {
      const next = vi.fn();
      expect(() =>
        forceHttps(fakeReq({ secure: false, headers: { 'x-forwarded-proto': 'http' } }), {} as Response, next),
      ).toThrowError(expect.objectContaining({ status: 403 }));
    });
  });
});
