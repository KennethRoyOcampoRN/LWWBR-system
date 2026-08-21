import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../../../src/modules/auth/passwords.js';

describe('passwords', () => {
  it('round-trips a correct password', async () => {
    const hash = await hashPassword('Waku2026!');
    expect(await verifyPassword(hash, 'Waku2026!')).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('Waku2026!');
    expect(await verifyPassword(hash, 'wrong-password')).toBe(false);
  });

  it('never stores the password in plaintext', async () => {
    const hash = await hashPassword('Waku2026!');
    expect(hash).not.toContain('Waku2026!');
    expect(hash.startsWith('$argon2')).toBe(true);
  });

  it('rejects a malformed hash instead of throwing', async () => {
    expect(await verifyPassword('not-a-real-hash', 'anything')).toBe(false);
  });
});
