// Spec §6 AmenityItem.category. A closed set, unlike MenuItem's free-text
// `category` — spec gives AmenityItem an explicit Prisma enum
// (AmenityCategory) but leaves MenuItem's category as a plain string, so
// this mirrors that same distinction rather than inventing one.
export const AMENITY_CATEGORY_KEYS = ['CONSOLE', 'VIDEOKE', 'BOARD_GAME', 'OUTDOOR', 'OTHER'] as const;
export type AmenityCategoryKey = (typeof AMENITY_CATEGORY_KEYS)[number];
