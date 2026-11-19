import { TZDate } from '@date-fns/tz';
import { ApiError } from '../../lib/apiError.js';
import { prisma } from '../../lib/prisma.js';
import type { CreateRatePlanInput, SetRatePlanRateInput, UpdateRatePlanInput } from './schema.js';

interface RatePlanActor {
  id: string;
}

// Same Asia/Manila-midnight parsing billing/service.ts and
// bookings/service.ts each already duplicate locally under their own
// name — not promoted to a shared lib location for the same reason
// billing/service.ts's own copy gives: no caller here justifies it on
// its own either.
const RESORT_TIMEZONE = 'Asia/Manila';
function resolveManilaDate(dateStr: string): Date {
  const [year, month, day] = dateStr.split('-').map(Number) as [number, number, number];
  return new TZDate(year, month - 1, day, 0, 0, RESORT_TIMEZONE);
}

function ratePlanRateToJson<T extends { rate: unknown; dayTourRate: unknown; extraPersonRate: unknown }>(rate: T) {
  return {
    ...rate,
    rate: Number(rate.rate),
    dayTourRate: rate.dayTourRate === null ? null : Number(rate.dayTourRate),
    extraPersonRate: rate.extraPersonRate === null ? null : Number(rate.extraPersonRate),
  };
}

function ratePlanToJson<T extends { rates?: { rate: unknown; dayTourRate: unknown; extraPersonRate: unknown }[] }>(plan: T) {
  return { ...plan, rates: plan.rates?.map(ratePlanRateToJson) };
}

const RATE_PLAN_INCLUDE = {
  rates: { include: { unitType: { select: { id: true, name: true } } } },
} as const;

// Lightweight listing for the cashier-facing picker (billing/router.ts's
// GET /bookings/:bookingId/rate-plans) — just id/name, not the full
// admin shape listRatePlans returns (nested RatePlanRate rows, inactive
// and soft-deleted plans included). A cashier chooses from active plans
// only; an inactive or deleted one is never offered, only ever reached
// historically via a FolioCharge.ratePlanId that already points at one.
export async function listActiveRatePlans() {
  return prisma.ratePlan.findMany({
    where: { deletedAt: null, isActive: true },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
}

export async function listRatePlans() {
  const plans = await prisma.ratePlan.findMany({
    where: { deletedAt: null },
    include: RATE_PLAN_INCLUDE,
    orderBy: { createdAt: 'asc' },
  });
  return plans.map(ratePlanToJson);
}

export async function createRatePlan(input: CreateRatePlanInput, actor: RatePlanActor) {
  const plan = await prisma.ratePlan.create({
    data: {
      name: input.name,
      startDate: input.startDate ? resolveManilaDate(input.startDate) : null,
      endDate: input.endDate ? resolveManilaDate(input.endDate) : null,
      weekdayMask: input.weekdayMask ?? null,
      createdById: actor.id,
    },
    include: RATE_PLAN_INCLUDE,
  });
  return ratePlanToJson(plan);
}

async function requireRatePlan(id: string) {
  const plan = await prisma.ratePlan.findFirst({ where: { id, deletedAt: null } });
  if (!plan) {
    throw new ApiError(404, 'NOT_FOUND', 'Rate plan not found');
  }
  return plan;
}

export async function updateRatePlan(id: string, input: UpdateRatePlanInput, _actor: RatePlanActor) {
  await requireRatePlan(id);
  const plan = await prisma.ratePlan.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.startDate !== undefined ? { startDate: input.startDate ? resolveManilaDate(input.startDate) : null } : {}),
      ...(input.endDate !== undefined ? { endDate: input.endDate ? resolveManilaDate(input.endDate) : null } : {}),
      ...(input.weekdayMask !== undefined ? { weekdayMask: input.weekdayMask } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    },
    include: RATE_PLAN_INCLUDE,
  });
  return ratePlanToJson(plan);
}

// Spec.md §13 decision 29: soft-delete only, same posture as every other
// model in this codebase — FolioCharge.ratePlanId is purely historical
// (the charge's own unitPrice is already the frozen, resolved number),
// so nothing downstream needs this row to keep existing; it's deleted
// so it stops being offered or suggested, not because anything would
// break if it disappeared.
export async function deleteRatePlan(id: string, _actor: RatePlanActor) {
  await requireRatePlan(id);
  await prisma.ratePlan.update({ where: { id }, data: { deletedAt: new Date() } });
  return { id };
}

// Upsert, not a plain update — the Setup UI's "fill in a rate for every
// room type" flow calls this once per unit type, and the first call for
// any given (plan, unitType) pair has no existing row to update yet.
// Spec.md §13 decision 37: dayTourRate/extraPersonRate are a full
// replace on every call (undefined treated the same as null), matching
// the schema's own doc comment — the Setup Rates editor always submits
// its whole current draft row, never a partial one.
export async function setRatePlanRate(ratePlanId: string, unitTypeId: string, input: SetRatePlanRateInput, _actor: RatePlanActor) {
  await requireRatePlan(ratePlanId);
  const unitType = await prisma.unitType.findFirst({ where: { id: unitTypeId, deletedAt: null } });
  if (!unitType) {
    throw new ApiError(404, 'NOT_FOUND', 'Unit type not found');
  }
  const dayTourRate = input.dayTourRate ?? null;
  const extraPersonRate = input.extraPersonRate ?? null;
  const rate = await prisma.ratePlanRate.upsert({
    where: { ratePlanId_unitTypeId: { ratePlanId, unitTypeId } },
    create: { ratePlanId, unitTypeId, rate: input.rate, dayTourRate, extraPersonRate },
    update: { rate: input.rate, dayTourRate, extraPersonRate },
  });
  return ratePlanRateToJson(rate);
}

// Spec.md §13 decision 29: the deliberate "fail loudly" escape hatch —
// removing a plan's rate for one room type means that room type can no
// longer be charged under this plan at all (resolveRatePlanRate below
// 422s rather than falling through to anything), not that it silently
// prices at zero or at UnitType.baseRate. Exists specifically so the
// client's own two failure scenarios (every plan deactivated; a plan
// missing a rate for one room type) are both reachable and testable.
export async function deleteRatePlanRate(ratePlanId: string, unitTypeId: string, _actor: RatePlanActor) {
  const existing = await prisma.ratePlanRate.findUnique({ where: { ratePlanId_unitTypeId: { ratePlanId, unitTypeId } } });
  if (!existing) {
    throw new ApiError(404, 'NOT_FOUND', 'This rate plan has no rate set for this room type.');
  }
  await prisma.ratePlanRate.delete({ where: { ratePlanId_unitTypeId: { ratePlanId, unitTypeId } } });
  return { ratePlanId, unitTypeId };
}

// Spec.md §13 decision 29 (2026-11-15): the client's own requirement —
// "a room with no price under the selected plan needs to fail loudly
// rather than silently charge zero." No fallback to UnitType.baseRate
// here at all, not even for the seeded "Standard" plan — every plan,
// Standard included, must have complete RatePlanRate coverage, or the
// one room type it's missing 422s exactly the way any other plan's gap
// would. This is what billing/service.ts's priceRoomCharge calls to
// turn a cashier's chosen ratePlanId into an actual number.
export async function resolveRatePlanRate(ratePlanId: string, unitTypeId: string): Promise<{ rate: number; ratePlanName: string }> {
  const plan = await prisma.ratePlan.findFirst({ where: { id: ratePlanId, deletedAt: null } });
  if (!plan || !plan.isActive) {
    throw new ApiError(
      422,
      'RATE_PLAN_INACTIVE',
      'This rate plan is no longer active — pick a different one before charging this room.',
    );
  }
  const rate = await prisma.ratePlanRate.findUnique({ where: { ratePlanId_unitTypeId: { ratePlanId, unitTypeId } } });
  if (!rate) {
    throw new ApiError(
      422,
      'RATE_PLAN_RATE_MISSING',
      `"${plan.name}" has no rate set for this room type yet — set one in Rate Plans before charging a room under it.`,
    );
  }
  return { rate: Number(rate.rate), ratePlanName: plan.name };
}

// Spec.md §13 decision 29: "remembered" half of the per-booking rate
// plan memory — the newest ROOM FolioCharge with a non-null ratePlanId
// across every Booking row the cashier's own gatherBookingIdsForBilling
// already gathers for this external booking group. Deliberately not
// filtered on FolioCharge.status: a charge that was later voided or
// deleted still reflects a real choice the cashier made for this
// booking a moment ago, which is exactly what this exists to recall —
// only a soft-deleted row (deletedAt) is excluded, same as every other
// query in this codebase that reads "this booking's charges."
export async function getLastUsedRatePlanId(bookingIds: string[]): Promise<string | null> {
  const last = await prisma.folioCharge.findFirst({
    where: { bookingId: { in: bookingIds }, source: 'ROOM', ratePlanId: { not: null }, deletedAt: null },
    orderBy: { postedAt: 'desc' },
  });
  return last?.ratePlanId ?? null;
}

interface RatePlanSuggestion {
  ratePlanId: string | null;
  reason: 'remembered' | 'date-match' | 'standard-default' | 'none';
}

// Spec.md §13 decision 29: suggestion only — never authoritative, never
// evaluated to decide what a guest pays (that's resolveRatePlanRate's
// job once the cashier has actually chosen). Three rungs, each one a
// convenience, not a priority ladder needing the old RateRule design's
// rigor: (1) the plan this booking group was last charged a room under,
// if it's still active and non-deleted — picking up where the cashier
// left off across this booking's other rooms; (2) failing that, the
// best date/weekday match among active plans, "best" meaning the plan
// whose suggestion fields are more specific (both date range and
// weekday set beats either alone), ties broken by most recently
// created; (3) failing that, the plan literally named "Standard," if
// one exists and is still active. A cashier can always override
// whatever this suggests — see postFolioCharge's RATE_PLAN_MISMATCH
// soft-warn for the one place an override is flagged back, not merely
// allowed silently.
export async function suggestRatePlanForBooking(
  bookingIds: string[],
  stayFrom: Date,
  stayTo: Date,
): Promise<RatePlanSuggestion> {
  const lastUsed = await getLastUsedRatePlanId(bookingIds);
  if (lastUsed) {
    const plan = await prisma.ratePlan.findFirst({ where: { id: lastUsed, deletedAt: null, isActive: true } });
    if (plan) {
      return { ratePlanId: plan.id, reason: 'remembered' };
    }
  }

  const activePlans = await prisma.ratePlan.findMany({ where: { deletedAt: null, isActive: true } });
  // Manila has no DST, so +24h in UTC terms always lands on the next
  // Manila midnight too — but the weekday must still be read back via a
  // Manila-anchored TZDate, not plain Date's getUTCDay(), or every
  // weekday here would be off by one (Manila midnight is 16:00 UTC the
  // previous day).
  const stayWeekdays = new Set<number>();
  for (let t = stayFrom.getTime(); t < stayTo.getTime(); t += 24 * 60 * 60 * 1000) {
    stayWeekdays.add(new TZDate(t, RESORT_TIMEZONE).getDay());
  }

  let best: { plan: (typeof activePlans)[number]; specificity: number } | null = null;
  for (const plan of activePlans) {
    const hasDateRange = plan.startDate !== null && plan.endDate !== null;
    const dateMatches = hasDateRange && stayFrom < plan.endDate! && stayTo > plan.startDate!;
    const hasWeekdayMask = plan.weekdayMask !== null;
    const weekdayMatches = hasWeekdayMask && [...stayWeekdays].some((day) => ((plan.weekdayMask! >> day) & 1) === 1);

    if (hasDateRange && !dateMatches) continue; // a date range that doesn't cover the stay disqualifies the plan outright
    if (hasWeekdayMask && !weekdayMatches) continue; // same for a weekday mask that never includes a night of the stay
    if (!hasDateRange && !hasWeekdayMask) continue; // a plan suggesting nothing (e.g. "Standard") is never suggested by match

    const specificity = (hasDateRange ? 1 : 0) + (hasWeekdayMask ? 1 : 0);
    if (!best || specificity > best.specificity || (specificity === best.specificity && plan.createdAt > best.plan.createdAt)) {
      best = { plan, specificity };
    }
  }
  if (best) {
    return { ratePlanId: best.plan.id, reason: 'date-match' };
  }

  const standard = await prisma.ratePlan.findFirst({ where: { name: 'Standard', deletedAt: null, isActive: true } });
  if (standard) {
    return { ratePlanId: standard.id, reason: 'standard-default' };
  }

  return { ratePlanId: null, reason: 'none' };
}

// Spec.md §13 decision 29: a three-room booking could otherwise drift
// across plans without anyone noticing — the client's own concern.
// Mismatch is only ever checked against the "remembered" rung above
// (reason: 'remembered'); if nothing has been charged under a plan yet
// for this booking group, there's nothing to mismatch against, so this
// returns false rather than warning on the very first room charged.
export async function checkRatePlanMismatch(
  bookingIds: string[],
  chosenRatePlanId: string,
): Promise<{ mismatched: boolean; lastRatePlanId: string | null }> {
  const lastRatePlanId = await getLastUsedRatePlanId(bookingIds);
  return { mismatched: lastRatePlanId !== null && lastRatePlanId !== chosenRatePlanId, lastRatePlanId };
}
