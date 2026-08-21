import * as OTPAuth from 'otpauth';

// Spec §3.1.1: "Two-factor authentication (TOTP) required for OWNER and
// SYSTEM_ADMIN, optional for everyone else." This module is role-agnostic
// (it just generates/verifies codes for whatever secret it's given) —
// which roles require it is decided in loginThrottle.ts's sibling,
// requiresTotp.ts, kept separate because that IS a deliberate, commented
// exception to spec §5.1's "don't hardcode role names," not something to
// bury inside the crypto module.
const ISSUER = 'Lucky Waku-Waku Resort';

export function generateTotpSecret(): string {
  return new OTPAuth.Secret({ size: 20 }).base32;
}

// The URI an authenticator app (Google Authenticator, Authy, etc.) reads
// via QR code to enroll the account.
export function totpProvisioningUri(secret: string, accountLabel: string): string {
  const totp = new OTPAuth.TOTP({
    issuer: ISSUER,
    label: accountLabel,
    secret: OTPAuth.Secret.fromBase32(secret),
  });
  return totp.toString();
}

// window: 1 tolerates one 30-second step of clock drift either side —
// standard practice for TOTP verification, not a security weakening
// (each accepted step is still a fresh, single-use 6-digit code).
export function verifyTotpCode(secret: string, code: string): boolean {
  const totp = new OTPAuth.TOTP({ issuer: ISSUER, secret: OTPAuth.Secret.fromBase32(secret) });
  return totp.validate({ token: code, window: 1 }) !== null;
}
