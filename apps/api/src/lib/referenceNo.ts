import { prisma } from './prisma.js';

// Spec §6.1: "WorkOrder, Booking, FnbOrder, AmenityRequest, StockRequest,
// Incident each get a human-readable referenceNo (WO-260821-0031,
// LWW-2026-0417). Generate in a single shared service with a per-day
// sequence." One `ReferenceSequence` row per (prefix, date) scope; the
// upsert's implicit INSERT-or-UPDATE takes a row-level lock in Postgres,
// so two concurrent requests for the same scope still get distinct,
// gapless sequence numbers rather than a race.
export async function generateReferenceNo(prefix: string, digits = 4): Promise<string> {
  const now = new Date();
  const yy = String(now.getUTCFullYear() % 100).padStart(2, '0');
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const scope = `${prefix}-${yy}${mm}${dd}`;

  const { seq } = await prisma.referenceSequence.upsert({
    where: { scope },
    update: { seq: { increment: 1 } },
    create: { scope, seq: 1 },
  });

  return `${scope}-${String(seq).padStart(digits, '0')}`;
}
