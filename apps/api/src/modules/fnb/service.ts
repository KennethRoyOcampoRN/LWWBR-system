import { DEFAULT_FNB_ADVANCE_ORDER_LEAD_MINUTES, getFnbOrderTransition, type PermissionKey, type PermissionScope } from '@lwwbr/shared';
import { getRealtimeAdapter } from '../../adapters/realtime/index.js';
import { ApiError } from '../../lib/apiError.js';
import { prisma } from '../../lib/prisma.js';
import { generateReferenceNo } from '../../lib/referenceNo.js';
import type {
  ChangeFnbOrderStatusInput,
  CreateFnbOrderInput,
  CreateMenuItemInput,
  ListFnbOrdersQuery,
  UpdateMenuItemInput,
} from './schema.js';

const ADVANCE_ORDER_LEAD_SETTING_KEY = 'fnb.advanceOrderLeadMinutes';

interface FnbOrderActor {
  id: string;
  permissions: Partial<Record<PermissionKey, PermissionScope>>;
}

const FNB_ORDER_INCLUDE = {
  unit: { select: { id: true, code: true, name: true } },
  createdBy: { select: { id: true, fullName: true } },
  cancelledBy: { select: { id: true, fullName: true } },
  lines: { include: { menuItem: { select: { id: true, name: true } } } },
} as const;

// Prisma's Decimal doesn't serialize to a plain JSON number on its own —
// same reasoning and pattern as amenities/service.ts's amenityItemToJson.
function menuItemToJson<T extends { price: unknown }>(item: T) {
  return { ...item, price: Number(item.price) };
}

// Spec §6: the restaurant menu. Order/kitchen-kanban is a separate,
// later slice. Ordered by sortOrder then name, same convention as
// UnitType (unlike AmenityItem, MenuItem does have a `sortOrder` field
// in spec's data model, so the client can arrange the menu the way it's
// actually printed rather than alphabetically).
export async function listMenuItems() {
  const items = await prisma.menuItem.findMany({
    where: { deletedAt: null },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
  return items.map(menuItemToJson);
}

export async function createMenuItem(input: CreateMenuItemInput) {
  const item = await prisma.menuItem.create({
    data: {
      name: input.name,
      category: input.category,
      price: input.price,
      isAvailable: input.isAvailable ?? true,
      prepMinutes: input.prepMinutes,
      sortOrder: input.sortOrder ?? 0,
    },
  });
  return menuItemToJson(item);
}

export async function updateMenuItem(id: string, input: UpdateMenuItemInput) {
  const existing = await prisma.menuItem.findFirst({ where: { id, deletedAt: null } });
  if (!existing) {
    throw new ApiError(404, 'NOT_FOUND', 'Menu item not found');
  }
  const item = await prisma.menuItem.update({ where: { id }, data: input });
  return menuItemToJson(item);
}

// Spec §7.3: "make the lead time a Setting" — same read-live-row,
// fall-back-to-shared-default pattern as workorders/service.ts's
// getPhotoRequirements, so the gate never goes silently unconfigured
// just because the Setting row doesn't exist yet.
async function getAdvanceOrderLeadMinutes(): Promise<number> {
  const setting = await prisma.setting.findUnique({ where: { key: ADVANCE_ORDER_LEAD_SETTING_KEY } });
  if (!setting || typeof setting.value !== 'number') {
    return DEFAULT_FNB_ADVANCE_ORDER_LEAD_MINUTES;
  }
  return setting.value;
}

// Same Decimal->number reasoning as menuItemToJson above, applied to the
// order's own subtotal and each line's snapshotted unitPrice.
function fnbOrderToJson<T extends { subtotal: unknown; lines: { unitPrice: unknown }[] }>(order: T) {
  return {
    ...order,
    subtotal: Number(order.subtotal),
    lines: order.lines.map((line) => ({ ...line, unitPrice: Number(line.unitPrice) })),
  };
}

async function broadcastFnbOrderChanged(event: 'fnb.order.created' | 'fnb.order.status.changed', params: {
  orderId: string;
  actorId: string;
  summary: string;
}): Promise<void> {
  try {
    await getRealtimeAdapter().emit('property', event, {
      entityId: params.orderId,
      actorId: params.actorId,
      at: new Date().toISOString(),
      summary: params.summary,
    });
  } catch (error) {
    console.error(`Realtime broadcast for ${event} failed:`, error);
  }
}

// Spec §7.3/§7.6: order creation. `settlement` (PAY_NOW vs
// CHARGE_TO_ROOM) is an informational classification only — client
// decision, 2026-08-24, extending M4's monitoring-not-transactions scope
// call to F&B: no `Payment` or `FolioCharge` is ever created from it, no
// balance is tracked, and `SERVED` never auto-posts anything. Spec's
// original `CHARGE_TO_ROOM` gate ("only selectable when the order links
// to a booking currently CHECKED_IN," refused at creation with `422
// NO_ACTIVE_FOLIO`) doesn't survive as-is with no folio to validate
// against — but the client asked to keep a lighter version: which room a
// charge-to-room order belongs to is still real, useful monitoring
// information, so this still requires a `unitId` and still refuses
// (`422 UNIT_NOT_OCCUPIED`) unless that unit's live status is
// `OCCUPIED`. Cheap (one row already needed for the FK) and answers a
// real question ("is this actually going to an occupied room") without
// any balance math behind it.
export async function createFnbOrder(input: CreateFnbOrderInput, actor: FnbOrderActor) {
  if (input.settlement === 'CHARGE_TO_ROOM') {
    if (!input.unitId) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'unitId is required for a CHARGE_TO_ROOM order.');
    }
    const unit = await prisma.unit.findFirst({ where: { id: input.unitId, deletedAt: null } });
    if (!unit || unit.status !== 'OCCUPIED') {
      throw new ApiError(422, 'UNIT_NOT_OCCUPIED', 'Charge-to-room requires a currently occupied unit.');
    }
  }

  const menuItemIds = [...new Set(input.lines.map((line) => line.menuItemId))];
  const menuItems = await prisma.menuItem.findMany({ where: { id: { in: menuItemIds }, deletedAt: null, isAvailable: true } });
  if (menuItems.length !== menuItemIds.length) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'One or more menu items are unknown or unavailable.');
  }
  const menuItemById = new Map(menuItems.map((item) => [item.id, item]));

  // Snapshot the price at order time, never re-derived from MenuItem
  // later — same "amount is stored, never recomputed from the source"
  // reasoning spec gives FolioCharge, applied here even without a folio:
  // a menu price change next week must not rewrite last week's order.
  const lines = input.lines.map((line) => {
    const menuItem = menuItemById.get(line.menuItemId)!;
    return { menuItemId: line.menuItemId, qty: line.qty, unitPrice: menuItem.price, notes: line.notes };
  });
  const subtotal = lines.reduce((sum, line) => sum + Number(line.unitPrice) * line.qty, 0);

  const referenceNo = await generateReferenceNo('FB');
  const order = await prisma.fnbOrder.create({
    data: {
      referenceNo,
      unitId: input.unitId,
      bookingId: input.bookingId,
      guestName: input.guestName,
      type: input.type,
      scheduledFor: input.scheduledFor ? new Date(input.scheduledFor) : undefined,
      settlement: input.settlement,
      subtotal,
      notes: input.notes,
      createdById: actor.id,
      lines: { create: lines },
    },
    include: FNB_ORDER_INCLUDE,
  });

  await broadcastFnbOrderChanged('fnb.order.created', {
    orderId: order.id,
    actorId: actor.id,
    summary: `${order.referenceNo} received`,
  });

  return fnbOrderToJson(order);
}

// Spec §7.3: RECEIVED/PREPARING/READY are the kitchen's active work;
// SERVED/CANCELLED drop off. `boardOnly` additionally hides an
// ADVANCE_ORDER until its lead-time window opens — the order already
// exists (placed earlier, e.g. by Admin Staff per spec §8.1), it just
// isn't the kitchen's concern yet.
export async function listFnbOrders(query: ListFnbOrdersQuery) {
  const where: Record<string, unknown> = { deletedAt: null };
  if (query.status) {
    where.status = query.status;
  }
  if (query.boardOnly) {
    where.status = { in: ['RECEIVED', 'PREPARING', 'READY'] };
    const leadMinutes = await getAdvanceOrderLeadMinutes();
    const cutoff = new Date(Date.now() + leadMinutes * 60_000);
    where.OR = [{ type: { not: 'ADVANCE_ORDER' } }, { scheduledFor: { lte: cutoff } }];
  }
  if (query.history) {
    // Same explicit-status-set spirit as boardOnly's own filter, just the
    // complement: whatever's dropped off the active board. `status`
    // (if also given) still narrows within this set, since it's applied
    // above unconditionally.
    if (!query.status) {
      where.status = { in: ['SERVED', 'CANCELLED'] };
    }
  }

  const orders = await prisma.fnbOrder.findMany({
    where,
    orderBy: [{ createdAt: query.history ? 'desc' : 'asc' }],
    // History can accumulate indefinitely; cap it the same way any
    // other "recent activity" list in this codebase does rather than
    // ever loading an unbounded table.
    take: query.history ? 200 : undefined,
    include: FNB_ORDER_INCLUDE,
  });
  return orders.map(fnbOrderToJson);
}

export async function getFnbOrder(id: string) {
  const order = await prisma.fnbOrder.findFirst({ where: { id, deletedAt: null }, include: FNB_ORDER_INCLUDE });
  if (!order) {
    throw new ApiError(404, 'NOT_FOUND', 'F&B order not found');
  }
  return fnbOrderToJson(order);
}

export async function changeFnbOrderStatus(id: string, input: ChangeFnbOrderStatusInput, actor: FnbOrderActor) {
  const order = await prisma.fnbOrder.findFirst({ where: { id, deletedAt: null } });
  if (!order) {
    throw new ApiError(404, 'NOT_FOUND', 'F&B order not found');
  }

  const fromStatus = order.status;
  const transition = getFnbOrderTransition(fromStatus, input.toStatus);
  if (!transition) {
    throw new ApiError(422, 'INVALID_TRANSITION', `Cannot move an F&B order from ${fromStatus} to ${input.toStatus}`);
  }
  if (!actor.permissions[transition.permission]) {
    throw new ApiError(403, 'FORBIDDEN', `Missing permission: ${transition.permission}`);
  }

  const data: Record<string, unknown> = { status: input.toStatus, version: { increment: 1 } };
  if (input.toStatus === 'PREPARING') {
    data.acknowledgedById = actor.id;
    data.acknowledgedAt = new Date();
    data.preparingAt = new Date();
  }
  if (input.toStatus === 'READY') {
    data.readyAt = new Date();
  }
  if (input.toStatus === 'SERVED') {
    data.servedAt = new Date();
  }
  if (input.toStatus === 'CANCELLED') {
    data.cancelledById = actor.id;
    data.cancelledAt = new Date();
    data.cancelReason = input.cancelReason;
  }

  const updated = await prisma.fnbOrder.update({ where: { id }, data, include: FNB_ORDER_INCLUDE });

  await broadcastFnbOrderChanged('fnb.order.status.changed', {
    orderId: updated.id,
    actorId: actor.id,
    summary: `${updated.referenceNo} moved to ${input.toStatus}`,
  });

  return fnbOrderToJson(updated);
}
