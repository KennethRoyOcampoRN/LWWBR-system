import { AsyncLocalStorage } from 'node:async_hooks';

// Carries per-request actor/ip/userAgent down into the Prisma audit
// extension (auditExtension.ts) without threading it through every
// function signature between an Express handler and a prisma.*.create()
// call several layers down. AsyncLocalStorage, not a module-level
// variable — each request gets its own isolated store, so this is safe
// under concurrent requests and doesn't violate spec §3.1's "no
// module-level mutable state" (that rule is about state that leaks
// *across* requests/cold starts; a per-request-scoped context that lives
// only for the request's async duration is the opposite of that).
export interface RequestContext {
  actorId: string | null;
  ip: string | null;
  userAgent: string | null;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getRequestContext(): RequestContext {
  return storage.getStore() ?? { actorId: null, ip: null, userAgent: null };
}

// Called once the actor's identity is known (requireAuth/requirePermission
// run after this module's Express middleware has already opened the
// context) — mutates the current request's own store object, not
// something shared across requests.
export function setRequestActorId(actorId: string): void {
  const context = storage.getStore();
  if (context) {
    context.actorId = actorId;
  }
}
