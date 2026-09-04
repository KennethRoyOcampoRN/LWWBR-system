import { ApiError } from '../../lib/apiError.js';
import { prisma } from '../../lib/prisma.js';
import type {
  CreateStockItemInput,
  CreateStockMovementInput,
  ListStockItemsQuery,
  ListStockMovementsQuery,
  UpdateStockItemInput,
} from './schema.js';

interface StockActor {
  id: string;
}

// Prisma's Decimal doesn't serialize to a plain JSON number on its own —
// same pattern as amenities/service.ts's amenityItemToJson.
function stockItemToJson<T extends { currentQty: unknown; reorderLevel: unknown }>(item: T) {
  return { ...item, currentQty: Number(item.currentQty), reorderLevel: Number(item.reorderLevel) };
}

function stockMovementToJson<T extends { delta: unknown }>(movement: T) {
  return { ...movement, delta: Number(movement.delta) };
}

export async function createStockItem(input: CreateStockItemInput, _actor: StockActor) {
  const item = await prisma.stockItem.create({
    data: {
      name: input.name,
      category: input.category,
      unitOfMeasure: input.unitOfMeasure,
      reorderLevel: input.reorderLevel,
      currentQty: input.initialQty ?? 0,
    },
  });
  return stockItemToJson(item);
}

// currentQty is deliberately not editable here — it stays driven only by
// movements (see createStockMovement below), so the audit trail can't be
// silently bypassed by hand-editing the count. updateStockItemSchema's
// own `.strict()` already rejects a currentQty field in the request body
// before this is ever reached; this comment is about why, not enforcement.
export async function updateStockItem(id: string, input: UpdateStockItemInput, _actor: StockActor) {
  const existing = await prisma.stockItem.findFirst({ where: { id, deletedAt: null } });
  if (!existing) {
    throw new ApiError(404, 'NOT_FOUND', 'Stock item not found');
  }
  const item = await prisma.stockItem.update({ where: { id }, data: input });
  return stockItemToJson(item);
}

export async function listStockItems(query: ListStockItemsQuery) {
  const items = await prisma.stockItem.findMany({
    where: { deletedAt: null, ...(query.isActive === undefined ? {} : { isActive: query.isActive }) },
    orderBy: [{ name: 'asc' }],
  });
  return items.map(stockItemToJson);
}

const STOCK_MOVEMENT_INCLUDE = { actor: { select: { id: true, fullName: true } } } as const;

// RECEIVE/CONSUME take a positive `quantity` (magnitude); ADJUST takes
// the signed correction directly — see createStockMovementSchema's own
// comment. Movement + currentQty update run in one $transaction (array
// form, same convention as roles/service.ts's grant replace) with
// Prisma's `increment` doing the arithmetic server-side, so two
// concurrent movements can never silently clobber each other's delta the
// way a naive read-then-write would. The negative-quantity guard for
// CONSUME is checked against the currentQty read just above the
// transaction — a small, accepted race window (another movement landing
// in between) rather than a hard DB-level constraint, consistent with
// this app's existing risk tolerance elsewhere (no optimistic-lock
// version field exists on StockItem to do better without a schema
// change, and this app's actual movement volume doesn't warrant one).
export async function createStockMovement(
  stockItemId: string,
  input: CreateStockMovementInput,
  actor: StockActor,
) {
  const item = await prisma.stockItem.findFirst({ where: { id: stockItemId, deletedAt: null } });
  if (!item) {
    throw new ApiError(404, 'NOT_FOUND', 'Stock item not found');
  }
  if (!item.isActive) {
    throw new ApiError(409, 'ITEM_INACTIVE', 'This stock item is inactive — reactivate it before logging movements.');
  }

  let delta: number;
  if (input.reason === 'ADJUST') {
    delta = input.quantity;
  } else {
    if (input.quantity < 0) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'quantity must be positive for RECEIVE/CONSUME — use ADJUST for a signed correction.');
    }
    delta = input.reason === 'RECEIVE' ? input.quantity : -input.quantity;
  }

  const resultingQty = Number(item.currentQty) + delta;
  if (resultingQty < 0) {
    throw new ApiError(422, 'INSUFFICIENT_STOCK', `Only ${item.currentQty} ${item.unitOfMeasure} of ${item.name} available.`);
  }

  const [movement] = await prisma.$transaction([
    prisma.stockMovement.create({
      data: { stockItemId, delta, reason: input.reason, actorId: actor.id, note: input.note },
      include: STOCK_MOVEMENT_INCLUDE,
    }),
    prisma.stockItem.update({ where: { id: stockItemId }, data: { currentQty: { increment: delta } } }),
  ]);

  return stockMovementToJson(movement);
}

export async function listStockMovements(query: ListStockMovementsQuery) {
  const movements = await prisma.stockMovement.findMany({
    where: query.stockItemId ? { stockItemId: query.stockItemId } : {},
    include: STOCK_MOVEMENT_INCLUDE,
    orderBy: [{ createdAt: 'desc' }],
  });
  return movements.map(stockMovementToJson);
}

export interface LowStockItem {
  id: string;
  name: string;
  category: string;
  unitOfMeasure: string;
  currentQty: number;
  reorderLevel: number;
}

// Command Center's low-stock KPI/attention-queue source. Deliberately
// unscoped by any stock:* permission — called unconditionally from
// getUnitsDashboard, same as listSlaBreachedWorkOrders/
// listOverdueAmenityRequests, both gated on unit:read alone (see that
// module's own doc comment for why that's not a leak). Unlike
// remittance:*/quotation:* last slice, there is no restricted-visibility
// question here at all — this is the client's own explicit instruction,
// not an inference, so kpi.lowStockItems/the queue array are ALWAYS
// present on the dashboard response, never optional/omitted, the
// opposite contract from pendingRemittances/pendingQuotations.
//
// "Drops below" (spec's own wording) is strict `<`, not `<=` — an item
// exactly at its reorder level is not yet flagged. Inactive items are
// excluded: no point alerting on a discontinued item's stale count.
export async function listLowStockItems(): Promise<LowStockItem[]> {
  const items = await prisma.stockItem.findMany({
    where: { deletedAt: null, isActive: true },
    select: { id: true, name: true, category: true, unitOfMeasure: true, currentQty: true, reorderLevel: true },
    orderBy: [{ name: 'asc' }],
  });
  return items
    .filter((item) => Number(item.currentQty) < Number(item.reorderLevel))
    .map((item) => ({
      id: item.id,
      name: item.name,
      category: item.category,
      unitOfMeasure: item.unitOfMeasure,
      currentQty: Number(item.currentQty),
      reorderLevel: Number(item.reorderLevel),
    }));
}
