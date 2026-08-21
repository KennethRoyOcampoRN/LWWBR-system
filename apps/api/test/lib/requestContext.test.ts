import { describe, expect, it } from 'vitest';
import { getRequestContext, runWithRequestContext, setRequestActorId } from '../../src/lib/requestContext.js';

describe('requestContext', () => {
  it('returns a default empty context outside any run()', () => {
    expect(getRequestContext()).toEqual({ actorId: null, ip: null, userAgent: null });
  });

  it('exposes the context set for the current run', async () => {
    await runWithRequestContext({ actorId: null, ip: '1.2.3.4', userAgent: 'test-agent' }, async () => {
      expect(getRequestContext()).toEqual({ actorId: null, ip: '1.2.3.4', userAgent: 'test-agent' });
    });
  });

  it('setRequestActorId mutates the current context in place', async () => {
    await runWithRequestContext({ actorId: null, ip: null, userAgent: null }, async () => {
      setRequestActorId('user_1');
      expect(getRequestContext().actorId).toBe('user_1');
    });
  });

  it('keeps concurrent contexts isolated from each other — the core guarantee this exists for', async () => {
    async function simulateRequest(actorId: string, delayMs: number) {
      return runWithRequestContext({ actorId: null, ip: null, userAgent: null }, async () => {
        setRequestActorId(actorId);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        // If this were a module-level variable instead of
        // AsyncLocalStorage, the slower request would see whichever
        // actorId was set last by *any* concurrent request, not its own.
        return getRequestContext().actorId;
      });
    }

    const [first, second] = await Promise.all([simulateRequest('user_A', 20), simulateRequest('user_B', 5)]);
    expect(first).toBe('user_A');
    expect(second).toBe('user_B');
  });
});
