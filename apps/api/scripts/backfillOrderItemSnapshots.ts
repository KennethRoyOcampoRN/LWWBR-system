// One-off data-integrity backfill, 2026-08-25 (Option B decision: real
// MenuItem/AmenityItem deletion, backed by name/price snapshots taken at
// order/request time). Every FnbOrderLine/AmenityRequest created from
// this point forward gets its item's name snapshotted at creation (see
// createFnbOrder/createAmenityRequest) — but every row created *before*
// this change has menuItemName/amenityItemName still NULL.
//
// Deliberately NOT backfilled from historical order data blind — the
// client flagged the real risk directly: a menu item's price or name may
// have changed since an old order was placed, so copying today's live
// values onto that old row could silently rewrite history with a value
// that was never actually true at the time. Two things make this
// backfill safe rather than a guess, though:
//
//   1. unitPrice was already snapshotted at order time since the very
//      first commit — this script never touches price, only name, so
//      the one field genuinely likely to drift (price) needs no backfill
//      at all; it's already correct.
//   2. This runs *now*, before any MenuItem/AmenityItem has ever been
//      hard-deleted (that capability doesn't exist until this same
//      commit) — every menuItemId/amenityItemId on every existing row is
//      still resolvable via its live relation. This is the one moment
//      backfilling from the live row is about as accurate as it will
//      ever be; waiting means some of these items may later be deleted
//      and the name becomes unrecoverable. A name is also far less
//      likely to have actually changed since order time than a price
//      (renaming a menu item is rare; adjusting its price is routine) —
//      so even in the cases where it *has* drifted, the risk is low.
//
// Idempotent: only touches rows where the snapshot is still NULL, so
// re-running after some rows are fixed (or after new rows arrive with
// their own snapshot already set) is a no-op for anything already
// covered.
//
// Run with: npx tsx scripts/backfillOrderItemSnapshots.ts
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const staleLines = await prisma.fnbOrderLine.findMany({
    where: { menuItemName: null, menuItemId: { not: null } },
    include: { menuItem: { select: { name: true } } },
  });
  console.warn(`Found ${staleLines.length} FnbOrderLine row(s) with no name snapshot.`);
  let fnbBackfilled = 0;
  for (const line of staleLines) {
    if (!line.menuItem) continue; // Already orphaned — nothing left to backfill from.
    await prisma.fnbOrderLine.update({ where: { id: line.id }, data: { menuItemName: line.menuItem.name } });
    fnbBackfilled += 1;
  }
  console.warn(`Backfilled ${fnbBackfilled} FnbOrderLine row(s) from their still-live MenuItem.`);

  const staleRequests = await prisma.amenityRequest.findMany({
    where: { amenityItemName: null, amenityItemId: { not: null } },
    include: { amenityItem: { select: { name: true } } },
  });
  console.warn(`Found ${staleRequests.length} AmenityRequest row(s) with no name snapshot.`);
  let amenityBackfilled = 0;
  for (const request of staleRequests) {
    if (!request.amenityItem) continue;
    await prisma.amenityRequest.update({ where: { id: request.id }, data: { amenityItemName: request.amenityItem.name } });
    amenityBackfilled += 1;
  }
  console.warn(`Backfilled ${amenityBackfilled} AmenityRequest row(s) from their still-live AmenityItem.`);

  console.warn('Done.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
