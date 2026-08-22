import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.js';
import { ApiRequestError } from '../lib/api.js';

// Pulls the raw secret out of the otpauth:// provisioning URI so it can be
// shown for manual entry — most authenticator apps also accept typing the
// secret directly, which matters here since this is plain text, not an
// actual scannable QR code (no QR-rendering dependency for one MVP screen
// that only OWNER/SYSTEM_ADMIN ever see).
function extractTotpSecret(provisioningUri: string): string | null {
  try {
    const url = new URL(provisioningUri);
    return url.searchParams.get('secret');
  } catch {
    return null;
  }
}

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();

  const [employeeCode, setEmployeeCode] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [needsTotp, setNeedsTotp] = useState(false);
  const [enrollment, setEnrollment] = useState<{ provisioningUri: string; secret: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await login(employeeCode, password, needsTotp || enrollment ? totpCode : undefined);
      if ('totpSetupRequired' in result) {
        setEnrollment({
          provisioningUri: result.provisioningUri,
          secret: extractTotpSecret(result.provisioningUri),
        });
        setNeedsTotp(true);
        return;
      }
      navigate('/', { replace: true });
    } catch (err) {
      if (err instanceof ApiRequestError) {
        if (err.code === 'TOTP_REQUIRED') {
          setNeedsTotp(true);
          setError(null);
          return;
        }
        if (err.code === 'ACCOUNT_LOCKED') {
          const lockedUntil = (err.details as { lockedUntil?: string } | undefined)?.lockedUntil;
          setError(
            lockedUntil
              ? `Account locked until ${new Date(lockedUntil).toLocaleString()}.`
              : 'Account temporarily locked.',
          );
          return;
        }
        setError(err.message);
        return;
      }
      setError('Something went wrong. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-6">
      <div>
        <h1 className="text-xl font-semibold">Lucky Waku-Waku Resort</h1>
        <p className="text-sm text-gray-600">Command Center sign in</p>
      </div>

      <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
        <label className="flex flex-col gap-1 text-sm font-medium">
          Employee code
          <input
            className="rounded border border-gray-300 px-3 py-2"
            value={employeeCode}
            onChange={(e) => setEmployeeCode(e.target.value)}
            autoComplete="username"
            disabled={needsTotp}
            required
          />
        </label>

        <label className="flex flex-col gap-1 text-sm font-medium">
          Password
          <input
            className="rounded border border-gray-300 px-3 py-2"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            disabled={needsTotp}
            required
          />
        </label>

        {enrollment && (
          <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm">
            <p className="font-medium">Set up your authenticator app</p>
            <p className="mt-1 text-gray-700">
              Add this account manually using the secret below, or paste this URI into an app that accepts it.
            </p>
            {enrollment.secret && (
              <p className="mt-2 break-all font-mono text-xs" data-testid="totp-secret">
                {enrollment.secret}
              </p>
            )}
          </div>
        )}

        {needsTotp && (
          <label className="flex flex-col gap-1 text-sm font-medium">
            Authenticator code
            <input
              className="rounded border border-gray-300 px-3 py-2"
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              required
            />
          </label>
        )}

        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="rounded bg-blue-600 px-3 py-2 font-medium text-white disabled:opacity-50"
        >
          {submitting ? 'Signing in…' : needsTotp ? 'Verify code' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
