import { ApiError } from '../../lib/apiError.js';
import { prisma } from '../../lib/prisma.js';
import type { CreateAmenityItemInput, UpdateAmenityItemInput } from './schema.js';

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
