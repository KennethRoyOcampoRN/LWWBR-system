import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import {
  generateRefreshToken,
  hashRefreshToken,
  signAccessToken,
  verifyAccessToken,
} from '../../../src/modules/auth/tokens.js';

describe('access tokens', () => {
  it('round-trips a signed token back to its userId', () => {
    const token = signAccessToken('user_123');
    expect(verifyAccessToken(token)).toEqual({ sub: 'user_123' });
  });

  it('rejects a garbage token', () => {
    expect(verifyAccessToken('not-a-real-token')).toBeNull();
  });

  it('rejects a token signed with a different secret', () => {
    // A token forged without knowing JWT_SECRET must never verify.
    const forged = jwt.sign({ sub: 'user_123' }, 'a-completely-different-secret-value');
    expect(verifyAccessToken(forged)).toBeNull();
  });
});

describe('refresh tokens', () => {
  it('generates high-entropy, distinct tokens', () => {
    const a = generateRefreshToken();
    const b = generateRefreshToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{96}$/);
  });

  it('hashes deterministically, so a session can be looked up by hash', () => {
    const token = generateRefreshToken();
    expect(hashRefreshToken(token)).toBe(hashRefreshToken(token));
    expect(hashRefreshToken(token)).not.toBe(token);
  });
});
