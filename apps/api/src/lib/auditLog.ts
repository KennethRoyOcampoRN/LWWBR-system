import type { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';

// Spec §4.4: every create/update/delete on a domain entity writes an
// AuditLog row. This is the shared write path; login/logout call it
// directly here since they aren't a generic entity mutation a Prisma
// middleware would catch. Task M1's requirePermission/audit middleware
// wraps this for everything else.
export interface AuditLogInput {
  actorId?: string | null;
  action: string;
  entity: string;
  entityId: string;
  before?: Prisma.InputJsonValue;
  after?: Prisma.InputJsonValue;
  ip?: string | null;
  userAgent?: string | null;
}

export async function logAudit(input: AuditLogInput): Promise<void> {
  await prisma.auditLog.create({
    data: {
      actorId: input.actorId ?? null,
      action: input.action,
      entity: input.entity,
      entityId: input.entityId,
      ...(input.before !== undefined ? { before: input.before } : {}),
      ...(input.after !== undefined ? { after: input.after } : {}),
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    },
  });
}
