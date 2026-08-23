// One-off data-integrity cleanup, 2026-08-23. Confirmed by SQL that R11
// (and possibly other units) sits at the retired INSPECTED status with
// zero UnitStatusEvent rows — proof it was never written by this app's
// code, in any version, past or present: seed.ts has never set `status`
// on a unit in any commit, the Prisma column default is VACANT_DIRTY,
// and changeUnitStatus() has unconditionally written a UnitStatusEvent
// for every transition since the very first M2 commit. The value must
// have been written directly against the database outside the app (SQL
// editor, Prisma Studio, or similar) at some earlier point.
//
// Rather than a raw SQL UPDATE (which would leave the same kind of
// silent, un-audited gap this script exists to clean up), this reuses
// the real forceUnitStatus() service function — the exact code path the
// UI's "Force status correction" panel already uses and that's already
// tested — so the fix creates a proper UnitStatusEvent + AuditLog
// entry, not another untraceable status flip. Idempotent: finds units
// currently at INSPECTED, so re-running after they're fixed is a no-op.
//
// Run with: npx tsx scripts/fixStaleInspectedUnits.ts
import { PrismaClient } from '@prisma/client';
import { forceUnitStatus } from '../src/modules/units/service.js';

const prisma = new PrismaClient();

async function main() {
  const staleUnits = await prisma.unit.findMany({
    where: { status: 'INSPECTED', deletedAt: null },
    select: { id: true, code: true, name: true, version: true },
  });

  if (staleUnits.length === 0) {
    console.warn('No units are currently sitting at the retired INSPECTED status. Nothing to fix.');
    return;
  }

  const systemAdmin = await prisma.user.findFirst({
    where: { roles: { some: { role: { key: 'SYSTEM_ADMIN' }, deletedAt: null } }, deletedAt: null },
    orderBy: { employeeCode: 'asc' },
  });
  if (!systemAdmin) {
    throw new Error('No SYSTEM_ADMIN user found to attribute this correction to — seed the database first.');
  }

  console.warn(`Found ${staleUnits.length} unit(s) stuck at INSPECTED with no event history:`);
  for (const unit of staleUnits) {
    console.warn(`  ${unit.code} — ${unit.name}`);
  }
  console.warn(`Correcting each to READY, attributed to ${systemAdmin.employeeCode}...`);

  for (const unit of staleUnits) {
    await forceUnitStatus(
      unit.id,
      {
        toStatus: 'READY',
        version: unit.version,
        note: 'One-off data-integrity cleanup, 2026-08-23: unit was sitting at the retired INSPECTED status with zero event history — never set by any version of this app\'s code, corrected here to READY. See fixStaleInspectedUnits.ts.',
      },
      { id: systemAdmin.id, permissions: { 'unit:force_status': 'ALL' } },
    );
    console.warn(`  ✔ ${unit.code} corrected to READY`);
  }

  console.warn('Done.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
