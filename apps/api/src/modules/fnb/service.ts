import { ApiError } from '../../lib/apiError.js';
import { prisma } from '../../lib/prisma.js';
import type { CreateMenuItemInput, UpdateMenuItemInput } from './schema.js';

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
