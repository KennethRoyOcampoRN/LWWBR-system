import { getAmenityRequestTransition, type PermissionKey, type PermissionScope } from '@lwwbr/shared';
import { getRealtimeAdapter } from '../../adapters/realtime/index.js';
import { ApiError } from '../../lib/apiError.js';
import { prisma } from '../../lib/prisma.js';
import { generateReferenceNo } from '../../lib/referenceNo.js';
import type {
  ChangeAmenityRequestStatusInput,
  CreateAmenityItemInput,
  CreateAmenityRequestInput,
  ListAmenityRequestsQuery,
  UpdateAmenityItemInput,
} from './schema.js';

interface AmenityRequestActor {
  id: string;
  permissions: Partial<Record<PermissionKey, PermissionScope>>;
}

const AMENITY_REQUEST_INCLUDE = {
  amenityItem: { select: { id: true, name: true, category: true, requiresDeposit: true, depositAmount: true } },
  unit: { select: { id: true, code: true, name: true } },
  requestedBy: { select: { id: true, fullName: true } },
  approvedBy: { select: { id: true, fullName: true } },
  issuedBy: { select: { id: true, fullName: true } },
  returnedBy: { select: { id: true, fullName: true } },
} as const;

// Prisma's Decimal doesn't serialize to a plain JSON number on its own —
// same reasoning and pattern as units/service.ts's unitTypeToJson.
function amenityItemToJson<T extends { depositAmount: unknown }>(item: T) {
  return { ...item, depositAmount: Number(item.depositAmount) };
}

// Spec §6: the amenity catalogue (PS4/PS5 console, videoke, board games,
// etc.) — request/issue/return workflow is a separate slice, not built
// yet. Ordered by name since, unlike UnitType, AmenityItem has no
// `sortOrder` field in spec's data model.
export async function listAmenityItems() {
  const items = await prisma.amenityItem.findMany({
    where: { deletedAt: null },
    orderBy: { name: 'asc' },
  });
  return items.map(amenityItemToJson);
}

export async function createAmenityItem(input: CreateAmenityItemInput) {
  const item = await prisma.amenityItem.create({
    data: {
      name: input.name,
      category: input.category,
      assetTag: input.assetTag,
      totalQty: input.totalQty,
      condition: input.condition,
      requiresDeposit: input.requiresDeposit ?? false,
      depositAmount: input.depositAmount ?? 0,
    },
  });
  return amenityItemToJson(item);
}

export async function updateAmenityItem(id: string, input: UpdateAmenityItemInput) {
  const existing = await prisma.amenityItem.findFirst({ where: { id, deletedAt: null } });
  if (!existing) {
    throw new ApiError(404, 'NOT_FOUND', 'Amenity item not found');
  }
  const item = await prisma.amenityItem.update({ where: { id }, data: input });
  return amenityItemToJson(item);
}

// Same Decimal->number reasoning as amenityItemToJson above, applied to
// the nested amenityItem the request/issue/return views need to show
// (e.g. "this item requires a ₱500 deposit") without a second round trip.
function amenityRequestToJson<T extends { amenityItem: { depositAmount: unknown } }>(request: T) {
  return { ...request, amenityItem: { ...request.amenityItem, depositAmount: Number(request.amenityItem.depositAmount) } };
}

// Spec §7.4/§9.1: amenity.request.changed on the same 'property' channel
// as workorder.created/unit.status.changed — best-effort, never fails the
// write it follows.
async function broadcastAmenityRequestChanged(params: {
  requestId: string;
  actorId: string;
  summary: string;
}): Promise<void> {
  try {
    await getRealtimeAdapter().emit('property', 'amenity.request.changed', {
      entityId: params.requestId,
      actorId: params.actorId,
      at: new Date().toISOString(),
      summary: params.summary,
    });
  } catch (error) {
    console.error('Realtime broadcast for amenity.request.changed failed:', error);
  }
}

// Spec §6/§7.4: request -> approve -> issue -> return. Property-wide, not
// actor-scoped on read — unlike workorder:read, amenity:read has no
// read_all/scope split in spec's permission key list (§5.3), so every
// holder simply sees every request.
export async function createAmenityRequest(input: CreateAmenityRequestInput, actor: AmenityRequestActor) {
  const item = await prisma.amenityItem.findFirst({ where: { id: input.amenityItemId, deletedAt: null, isActive: true } });
  if (!item) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Unknown or inactive amenity item');
  }

  const referenceNo = await generateReferenceNo('AR');
  const request = await prisma.amenityRequest.create({
    data: {
      referenceNo,
      amenityItemId: input.amenityItemId,
      bookingId: input.bookingId,
      unitId: input.unitId,
      qty: input.qty,
      notes: input.notes,
      requestedById: actor.id,
    },
    include: AMENITY_REQUEST_INCLUDE,
  });

  await broadcastAmenityRequestChanged({
    requestId: request.id,
    actorId: actor.id,
    summary: `${request.referenceNo} requested — ${item.name} x${request.qty}`,
  });

  return amenityRequestToJson(request);
}

export async function listAmenityRequests(query: ListAmenityRequestsQuery) {
  const requests = await prisma.amenityRequest.findMany({
    where: {
      deletedAt: null,
      ...(query.status ? { status: query.status } : {}),
      ...(query.amenityItemId ? { amenityItemId: query.amenityItemId } : {}),
    },
    orderBy: [{ createdAt: 'desc' }],
    include: AMENITY_REQUEST_INCLUDE,
  });
  return requests.map(amenityRequestToJson);
}

export async function getAmenityRequest(id: string) {
  const request = await prisma.amenityRequest.findFirst({
    where: { id, deletedAt: null },
    include: AMENITY_REQUEST_INCLUDE,
  });
  if (!request) {
    throw new ApiError(404, 'NOT_FOUND', 'Amenity request not found');
  }
  return amenityRequestToJson(request);
}

// Spec §7.4: "Items with requiresDeposit cannot move to ISSUED without a
// recorded deposit amount." Per the client's monitoring-not-transactions
// scope decision (2026-08-24, extended from M4 to M5), this is enforced
// as a plain confirmation gate — the issuer must tick "deposit
// collected" — not a Payment/FolioCharge posting. Nothing about the
// actual amount collected is persisted beyond that boolean; the item's
// own `depositAmount` stays the one informational reference figure, same
// as the amenity catalogue slice.
export async function changeAmenityRequestStatus(id: string, input: ChangeAmenityRequestStatusInput, actor: AmenityRequestActor) {
  const request = await prisma.amenityRequest.findFirst({
    where: { id, deletedAt: null },
    include: { amenityItem: true },
  });
  if (!request) {
    throw new ApiError(404, 'NOT_FOUND', 'Amenity request not found');
  }

  const fromStatus = request.status;
  const transition = getAmenityRequestTransition(fromStatus, input.toStatus);
  if (!transition) {
    throw new ApiError(422, 'INVALID_TRANSITION', `Cannot move an amenity request from ${fromStatus} to ${input.toStatus}`);
  }
  if (!actor.permissions[transition.permission]) {
    throw new ApiError(403, 'FORBIDDEN', `Missing permission: ${transition.permission}`);
  }

  const data: Record<string, unknown> = { status: input.toStatus };

  if (input.toStatus === 'APPROVED') {
    data.approvedById = actor.id;
  }

  if (input.toStatus === 'ISSUED') {
    // Real gap found live-testing, 2026-08-25: an item could be issued
    // past its totalQty with no warning at all — the system had no way
    // of knowing it was actually out of stock. "Currently out" is the
    // sum of qty across every other request on this same item still in
    // ISSUED or OVERDUE — OVERDUE is included deliberately: a unit that's
    // overdue hasn't come back yet, so it must still count as unavailable
    // (excluding it would make stock look like it "reappeared" the
    // moment a borrower fails to return on time, which is backwards).
    const outstanding = await prisma.amenityRequest.aggregate({
      where: { amenityItemId: request.amenityItemId, status: { in: ['ISSUED', 'OVERDUE'] }, deletedAt: null },
      _sum: { qty: true },
    });
    const currentlyOut = outstanding._sum.qty ?? 0;
    const available = request.amenityItem.totalQty - currentlyOut;
    if (request.qty > available) {
      throw new ApiError(
        409,
        'INSUFFICIENT_STOCK',
        `Only ${Math.max(available, 0)} of ${request.amenityItem.totalQty} ${request.amenityItem.name} available right now.`,
        { available: Math.max(available, 0), totalQty: request.amenityItem.totalQty, requestedQty: request.qty },
      );
    }

    if (request.amenityItem.requiresDeposit && !input.depositCollected) {
      throw new ApiError(
        422,
        'DEPOSIT_REQUIRED',
        'Confirm the deposit was collected before issuing this item.',
      );
    }
    if (!input.dueBackAt) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'dueBackAt is required when issuing an amenity item.');
    }
    data.issuedById = actor.id;
    data.issuedAt = new Date();
    data.dueBackAt = new Date(input.dueBackAt);
  }

  if (input.toStatus === 'RETURNED' || input.toStatus === 'LOST_DAMAGED') {
    data.returnedById = actor.id;
    data.returnedAt = new Date();
    data.conditionOnReturn = input.conditionOnReturn;
  }

  if (input.notes !== undefined) {
    data.notes = input.notes;
  }

  const updated = await prisma.amenityRequest.update({ where: { id }, data, include: AMENITY_REQUEST_INCLUDE });

  await broadcastAmenityRequestChanged({
    requestId: updated.id,
    actorId: actor.id,
    summary: `${updated.referenceNo} moved to ${input.toStatus}`,
  });

  return amenityRequestToJson(updated);
}

// Spec §7.4: "ISSUED past dueBackAt auto-flips to OVERDUE via POST
// /api/v1/jobs/amenity-overdue, called every 15 minutes by a Netlify
// Scheduled Function in production and triggered manually in local dev."
// A bulk updateMany, not the per-row changeAmenityRequestStatus above —
// this is the one place ISSUED -> OVERDUE happens at all (see
// amenityRequest.ts's own comment on why that transition has no entry in
// the manual table), so it doesn't go through getAmenityRequestTransition
// or a permission check; the job route's shared-secret gate (jobs/
// router.ts) is the only authorization this needs.
export async function applyAmenityOverdueSweep(): Promise<{ flippedCount: number }> {
  const result = await prisma.amenityRequest.updateMany({
    where: { status: 'ISSUED', dueBackAt: { lt: new Date() }, deletedAt: null },
    data: { status: 'OVERDUE' },
  });
  return { flippedCount: result.count };
}
