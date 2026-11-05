import {
  BOOKING_STATUSES_EXCLUDED_FROM_AVAILABILITY,
  DEFAULT_FNB_ADVANCE_ORDER_LEAD_MINUTES,
  getFnbOrderTransition,
  type PermissionKey,
  type PermissionScope,
} from '@lwwbr/shared';
import { getStorageAdapter } from '../../adapters/storage/index.js';
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

// Same signed-URL-not-raw-storageKey reasoning as settings/service.ts's
// own logoToJson.
async function photoToJson(photoFileId: string | null) {
  if (!photoFileId) return null;
  const file = await prisma.fileObject.findFirst({ where: { id: photoFileId, deletedAt: null } });
  if (!file) return null;
  return { id: file.id, filename: file.filename, mimeType: file.mimeType, url: await getStorageAdapter().getSignedUrl(file.storageKey) };
}

// Prisma's Decimal doesn't serialize to a plain JSON number on its own —
// same reasoning and pattern as amenities/service.ts's amenityItemToJson.
async function menuItemToJson<T extends { price: unknown; photoFileId: string | null }>(item: T) {
  const { photoFileId, ...rest } = item;
  return { ...rest, price: Number(item.price), photo: await photoToJson(photoFileId) };
}

async function assertPhotoFileExists(photoFileId: string | null | undefined) {
  if (!photoFileId) return;
  const file = await prisma.fileObject.findFirst({ where: { id: photoFileId, deletedAt: null } });
  if (!file) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'The referenced photo file could not be found.');
  }
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
  return Promise.all(items.map(menuItemToJson));
}

export async function createMenuItem(input: CreateMenuItemInput) {
  await assertPhotoFileExists(input.photoFileId);
  const item = await prisma.menuItem.create({
    data: {
      name: input.name,
      category: input.category,
      price: input.price,
      isAvailable: input.isAvailable ?? true,
      prepMinutes: input.prepMinutes,
      sortOrder: input.sortOrder ?? 0,
      photoFileId: input.photoFileId ?? null,
    },
  });
  return menuItemToJson(item);
}

export async function updateMenuItem(id: string, input: UpdateMenuItemInput) {
  const existing = await prisma.menuItem.findFirst({ where: { id, deletedAt: null } });
  if (!existing) {
    throw new ApiError(404, 'NOT_FOUND', 'Menu item not found');
  }
  await assertPhotoFileExists(input.photoFileId);
  const item = await prisma.menuItem.update({ where: { id }, data: input });
  return menuItemToJson(item);
}

// Client decision, 2026-08-25 (Option B): a real MenuItem.delete() is
// now safe — every FnbOrderLine snapshots the item's name and price at
// order time (see createFnbOrder), and menuItemId is a nullable,
// onDelete: SetNull FK, so no historical order line depends on this row
// surviving. Still requires the item be marked unavailable first — a
// deliberate two-step (deactivate, then delete) so a currently-live menu
// item can't be removed in one click.
export async function deleteMenuItem(id: string) {
  const existing = await prisma.menuItem.findFirst({ where: { id, deletedAt: null } });
  if (!existing) {
    throw new ApiError(404, 'NOT_FOUND', 'Menu item not found');
  }
  if (existing.isAvailable) {
    throw new ApiError(409, 'ITEM_STILL_AVAILABLE', 'Mark the item unavailable before deleting it.');
  }
  await prisma.menuItem.delete({ where: { id } });
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
// order's own subtotal and each line's snapshotted unitPrice. `itemName`
// prefers the snapshot taken at order time (menuItemName); falls back to
// the live relation for any pre-snapshot historical row (see
// scripts/backfillOrderItemSnapshots.ts), and finally to a placeholder
// if the item was deleted before that backfill ever ran on this row.
function fnbOrderToJson<
  T extends {
    subtotal: unknown;
    lines: { unitPrice: unknown; menuItemName: string | null; menuItem: { name: string } | null }[];
  },
>(order: T) {
  return {
    ...order,
    subtotal: Number(order.subtotal),
    lines: order.lines.map((line) => ({
      ...line,
      unitPrice: Number(line.unitPrice),
      itemName: line.menuItemName ?? line.menuItem?.name ?? '(deleted item)',
    })),
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
  // Cashier-tab plan (spec.md §13.4, Stage B, 2026-11-05): a real
  // prerequisite gap found while planning the Cashier tab's F&B
  // pull-in — nothing set FnbOrder.bookingId for a CHARGE_TO_ROOM order
  // before this, so there was nothing for the billing side to find.
  // Resolved server-side, not by trusting input.bookingId from the
  // client: the unit's current, active BookingUnit (its booking not
  // CANCELLED/CHECKED_OUT) is the real answer, the same "Unit.status
  // === 'OCCUPIED' plus the booking isn't closed out" signal
  // bookings/service.ts already uses everywhere else. A unit can never
  // have two simultaneously-active assignments (checkInBooking refuses
  // check-in into an already-OCCUPIED unit), so this is always
  // well-defined once the unit-occupied check below passes.
  let chargeToRoomBookingId: string | null = null;
  if (input.settlement === 'CHARGE_TO_ROOM') {
    if (!input.unitId) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'unitId is required for a CHARGE_TO_ROOM order.');
    }
    const unit = await prisma.unit.findFirst({ where: { id: input.unitId, deletedAt: null } });
    if (!unit || unit.status !== 'OCCUPIED') {
      throw new ApiError(422, 'UNIT_NOT_OCCUPIED', 'Charge-to-room requires a currently occupied unit.');
    }
    const activeBookingUnit = await prisma.bookingUnit.findFirst({
      where: {
        unitId: input.unitId,
        deletedAt: null,
        booking: { deletedAt: null, status: { notIn: [...BOOKING_STATUSES_EXCLUDED_FROM_AVAILABILITY] } },
      },
    });
    chargeToRoomBookingId = activeBookingUnit?.bookingId ?? null;
  }

  const menuItemIds = [...new Set(input.lines.map((line) => line.menuItemId))];
  const menuItems = await prisma.menuItem.findMany({ where: { id: { in: menuItemIds }, deletedAt: null, isAvailable: true } });
  if (menuItems.length !== menuItemIds.length) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'One or more menu items are unknown or unavailable.');
  }
  const menuItemById = new Map(menuItems.map((item) => [item.id, item]));

  // Snapshot the price (and, as of the 2026-08-25 Option B decision, the
  // name) at order time, never re-derived from MenuItem later — same
  // "amount is stored, never recomputed from the source" reasoning spec
  // gives FolioCharge, applied here even without a folio: a menu price
  // or name change next week must not rewrite last week's order. The
  // name snapshot is also what makes a real MenuItem.delete() safe.
  const lines = input.lines.map((line) => {
    const menuItem = menuItemById.get(line.menuItemId)!;
    return {
      menuItemId: line.menuItemId,
      menuItemName: menuItem.name,
      qty: line.qty,
      unitPrice: menuItem.price,
      notes: line.notes,
    };
  });
  const subtotal = lines.reduce((sum, line) => sum + Number(line.unitPrice) * line.qty, 0);

  const referenceNo = await generateReferenceNo('FB');
  const order = await prisma.fnbOrder.create({
    data: {
      referenceNo,
      unitId: input.unitId,
      bookingId: input.settlement === 'CHARGE_TO_ROOM' ? chargeToRoomBookingId : input.bookingId,
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

// Real gap found live-testing, 2026-08-25: the Command Center's "Open
// F&B tickets" KPI card still said "Coming in M5" — F&B has been built
// and confirmed working since M5 closed. "Open" is the same population
// the kitchen board itself renders (see listFnbOrders's boardOnly
// branch above): RECEIVED/PREPARING/READY, with an ADVANCE_ORDER still
// hidden until its lead-time window opens — an advance order that isn't
// the kitchen's concern yet shouldn't inflate this count either.
export async function countOpenFnbOrders(): Promise<number> {
  const leadMinutes = await getAdvanceOrderLeadMinutes();
  const cutoff = new Date(Date.now() + leadMinutes * 60_000);
  return prisma.fnbOrder.count({
    where: {
      deletedAt: null,
      status: { in: ['RECEIVED', 'PREPARING', 'READY'] },
      OR: [{ type: { not: 'ADVANCE_ORDER' } }, { scheduledFor: { lte: cutoff } }],
    },
  });
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

// Cashier-tab plan (spec.md §13.4, Stage B, 2026-11-05): "unsettled"
// charge-to-room orders for the F&B pull-in — deliberately a NOT-EXISTS
// style filter rather than a new status column. There is no settled/
// unsettled lifecycle concept anywhere on FnbOrder (settlement is a
// payment-method classification only, never a state machine) — an
// order is unsettled if it's CHARGE_TO_ROOM, not CANCELLED, belongs to
// one of the given bookings, and no non-voided FolioCharge{source: FNB,
// sourceId: this order's id} has been created from it yet. Takes an
// array of bookingIds (not a single one) because one external booking
// ID can span several Booking rows (spec.md §13.4) — the caller
// (billing/service.ts) gathers that set first.
export async function listUnsettledChargeToRoomOrders(bookingIds: string[]) {
  if (bookingIds.length === 0) return [];
  const orders = await prisma.fnbOrder.findMany({
    where: {
      bookingId: { in: bookingIds },
      settlement: 'CHARGE_TO_ROOM',
      status: { not: 'CANCELLED' },
      deletedAt: null,
    },
    include: { unit: { select: { id: true, code: true, name: true } } },
    orderBy: { createdAt: 'asc' },
  });
  if (orders.length === 0) return [];

  const alreadyPulledInOrderIds = new Set(
    (
      await prisma.folioCharge.findMany({
        where: {
          source: 'FNB',
          sourceId: { in: orders.map((o) => o.id) },
          status: { not: 'VOIDED' },
          deletedAt: null,
        },
        select: { sourceId: true },
      })
    ).map((fc) => fc.sourceId),
  );

  return orders
    .filter((o) => !alreadyPulledInOrderIds.has(o.id))
    .map((o) => ({
      fnbOrderId: o.id,
      referenceNo: o.referenceNo,
      bookingId: o.bookingId as string,
      unit: o.unit,
      subtotal: Number(o.subtotal),
      createdAt: o.createdAt,
    }));
}
