import { PrismaClient, type Prisma } from '@prisma/client';
import {
  isAudited,
  modelDelegateName,
  needsBeforeRead,
  redactSensitiveFields,
  resolveEntityId,
} from './auditExtension.js';
import { getRequestContext } from './requestContext.js';

// Spec §4.4: every create/update/delete on a domain entity writes an
// AuditLog row — "implement it as Prisma middleware or a shared service
// wrapper, not by hand at each call site." This is the Prisma-extension
// route: every mutation through this client is captured automatically,
// so a future module can't forget to audit itself the way a per-call-site
// convention could be forgotten.
//
// NOT verified against a live database from this sandbox — this
// session's network is blocked to the hosted Supabase project (see the
// M0 commits). The logic this depends on (auditExtension.ts) is unit
// tested directly; the $allOperations wiring below follows Prisma's
// documented extension API but its actual behavior against Postgres
// needs confirming on a machine that can reach the database.
function createAuditedPrismaClient() {
  const base = new PrismaClient();

  return base.$extends({
    name: 'auditLog',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!isAudited(model, operation)) {
            return query(args);
          }

          let before: unknown;
          if (needsBeforeRead(operation) && args && typeof args === 'object' && 'where' in args) {
            // Read through `base`, not the extended client, so this
            // lookup doesn't re-trigger this same extension.
            const delegate = (base as unknown as Record<string, { findUnique: (args: unknown) => Promise<unknown> }>)[
              modelDelegateName(model)
            ];
            before = await delegate?.findUnique({ where: args.where }).catch(() => undefined);
          }

          const after = await query(args);

          const entityId = resolveEntityId(after) ?? resolveEntityId(before);
          if (entityId) {
            const context = getRequestContext();
            // Awaited inline rather than fire-and-forget: a serverless
            // function can exit immediately after responding, which
            // would drop a background write. The extra latency on every
            // mutation is the accepted cost of spec §4.4 being a hard
            // requirement, not optional.
            await base.auditLog.create({
              data: {
                actorId: context.actorId,
                action: operation.toUpperCase(),
                entity: model,
                entityId,
                ...(before !== undefined
                  ? { before: redactSensitiveFields(before) as Prisma.InputJsonValue }
                  : {}),
                ...(after !== undefined && after !== null
                  ? { after: redactSensitiveFields(after) as Prisma.InputJsonValue }
                  : {}),
                ip: context.ip,
                userAgent: context.userAgent,
              },
            });
          }

          return after;
        },
      },
    },
  });
}

// Module singleton guarded against hot-reload creating duplicate clients
// during local `tsx watch` dev — see spec §3.1 ("assume every request is a
// cold start; keep the Prisma client a module singleton guarded for
// hot-reload"). In a real serverless cold start this simply runs once.
const globalForPrisma = globalThis as unknown as { prisma?: ReturnType<typeof createAuditedPrismaClient> };

export const prisma = globalForPrisma.prisma ?? createAuditedPrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
