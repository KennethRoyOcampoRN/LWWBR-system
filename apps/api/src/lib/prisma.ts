import { PrismaClient } from '@prisma/client';

// Module singleton guarded against hot-reload creating duplicate clients
// during local `tsx watch` dev — see spec §3.1 ("assume every request is a
// cold start; keep the Prisma client a module singleton guarded for
// hot-reload"). In a real serverless cold start this simply runs once.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
