// One-off data migration, spec.md §13 decision 37 (2026-11-19):
// dayTourRate/extraPersonRate moved from UnitType onto RatePlanRate —
// "a rate plan owns every price." seed.ts's own Standard-plan loop
// already copies both onto a *newly created* RatePlanRate row (see its
// own comment), but that loop's create-if-missing guard means it never
// touches a row that already exists — which is every property that has
// already run this app's seed at least once, exactly the client's own
// case. This script is the other half: for a RatePlanRate row that
// already exists, with only `rate` ever set, backfill dayTourRate/
// extraPersonRate from the UnitType it belongs to.
//
// Scoped to the Standard plan only, per the client's own instruction —
// "migrate the existing values into the Standard plan's rates," not
// every plan. A plan like "December Xmas" starts with no day-tour/
// extra-person rate of its own; nothing here invents one for it.
//
// Idempotent and non-destructive: only fills a dayTourRate/
// extraPersonRate that is currently NULL on the RatePlanRate row, and
// only from a UnitType value that is itself non-null — never
// overwrites a value someone has already set through the Setup Rates
// UI (impossible before this script exists, but still the correct rule
// to state and hold to on every future re-run), and never invents a
// day-tour or extra-person rate for a room type that never had one.
// `rate` itself is never touched — it was already migrated by seed.ts
// when decision 29/30 shipped.
//
// Run with: npx tsx scripts/backfillRatePlanDayTourAndExtraPersonRates.ts
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const standardPlan = await prisma.ratePlan.findFirst({ where: { name: 'Standard', deletedAt: null } });
  if (!standardPlan) {
    console.warn('No "Standard" rate plan exists yet — nothing to backfill. Run the seed first.');
    return;
  }

  const unitTypes = await prisma.unitType.findMany({
    where: {
      deletedAt: null,
      OR: [{ dayTourRate: { not: null } }, { extraPersonRate: { not: null } }],
    },
  });
  console.warn(`Found ${unitTypes.length} unit type(s) with a legacy dayTourRate or extraPersonRate to check.`);

  let backfilled = 0;
  let skippedNoRow = 0;
  let skippedAlreadySet = 0;
  for (const unitType of unitTypes) {
    const existingRate = await prisma.ratePlanRate.findUnique({
      where: { ratePlanId_unitTypeId: { ratePlanId: standardPlan.id, unitTypeId: unitType.id } },
    });
    if (!existingRate) {
      // No Standard rate at all for this type yet — not this script's
      // job to invent one (that 422s RATE_PLAN_RATE_MISSING at charge
      // time until an admin sets one via Setup Rates, same as any
      // other plan gap).
      skippedNoRow += 1;
      continue;
    }
    const data: { dayTourRate?: number; extraPersonRate?: number } = {};
    if (existingRate.dayTourRate === null && unitType.dayTourRate !== null) {
      data.dayTourRate = Number(unitType.dayTourRate);
    }
    if (existingRate.extraPersonRate === null && unitType.extraPersonRate !== null) {
      data.extraPersonRate = Number(unitType.extraPersonRate);
    }
    if (Object.keys(data).length === 0) {
      skippedAlreadySet += 1;
      continue;
    }
    await prisma.ratePlanRate.update({ where: { id: existingRate.id }, data });
    backfilled += 1;
    console.warn(`  ${unitType.name}: ${JSON.stringify(data)}`);
  }

  console.warn(
    `Backfilled ${backfilled} RatePlanRate row(s). Skipped ${skippedNoRow} with no Standard rate yet, ${skippedAlreadySet} already fully set.`,
  );
  console.warn('Done.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
