// Pure logic for the audit Prisma extension (wired onto the client in
// prisma.ts). Kept separate and dependency-free so it's unit-testable
// without a real database — the extension wiring itself can't be
// exercised that way (it needs a live PrismaClient), but everything it
// decides is decided here.

// Models excluded from automatic audit capture:
// - AuditLog itself, so writing an audit row doesn't recursively audit
//   the audit write.
// - Session: its own churn is already covered by the explicit
//   LOGIN_SUCCESS / LOGIN_FAILURE / REFRESH_TOKEN_REUSE_DETECTED entries
//   written directly in modules/auth/service.ts, and a Session row
//   rewriting on every 15-minute token refresh would drown the log in
//   noise nobody reads.
export const UNAUDITED_MODELS = new Set(['AuditLog', 'Session']);

// updateMany/deleteMany are deliberately not audited — they don't carry
// a single entityId, and capturing per-row before/after for a bulk
// operation is a materially harder problem (reading N rows before and
// after) that isn't worth solving until something in this app actually
// needs bulk mutation of an audited model. Flagging this now rather than
// letting it be a silent gap discovered later: if a future milestone
// adds a bulk operation on an audited model, it needs its own explicit
// logAudit() call (lib/auditLog.ts) at the call site.
export const AUDITED_OPERATIONS = new Set(['create', 'update', 'delete', 'upsert']);

export function isAudited(model: string | undefined, operation: string): boolean {
  return Boolean(model) && !UNAUDITED_MODELS.has(model as string) && AUDITED_OPERATIONS.has(operation);
}

// Only update/delete/upsert have a meaningful pre-state to read before
// the write runs; create doesn't (the row doesn't exist yet).
export function needsBeforeRead(operation: string): boolean {
  return operation === 'update' || operation === 'delete' || operation === 'upsert';
}

export function resolveEntityId(record: unknown): string | null {
  if (record && typeof record === 'object' && 'id' in record) {
    const { id } = record as { id: unknown };
    if (typeof id === 'string') return id;
  }
  return null;
}

// Password/token hashes and (from a follow-up task) TOTP secrets must
// never sit in AuditLog.before/after — audit:read is granted broadly
// (SYS_ADMIN, RESORT_MANAGER, OWNER, per spec §5.4), far more broadly
// than anyone should be able to see raw credential material, even
// hashed. Add a field to this set the moment a model gains one.
const SENSITIVE_FIELDS = new Set(['passwordHash', 'refreshTokenHash', 'previousRefreshTokenHash', 'totpSecret']);

export function redactSensitiveFields<T>(record: T): T {
  if (!record || typeof record !== 'object') return record;
  const clone = { ...(record as Record<string, unknown>) };
  for (const field of SENSITIVE_FIELDS) {
    if (field in clone) {
      clone[field] = '[redacted]';
    }
  }
  return clone as T;
}

// The camelCase delegate name Prisma exposes on the client for a given
// PascalCase model name (User -> prisma.user), needed to issue the
// "before" read through the base (unextended) client from inside the
// extension itself.
export function modelDelegateName(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1);
}
