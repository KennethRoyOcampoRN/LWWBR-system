import {
  getTransition,
  type PermissionKey,
  type PermissionScope,
  type RoleKey,
  type UnitStatusKey,
} from '@lwwbr/shared';
import { ApiError } from '../../lib/apiError.js';
import { logAudit } from '../../lib/auditLog.js';
import { prisma } from '../../lib/prisma.js';
import { canOverrideAutomaticTransition } from './automaticTransitionOverride.js';
import type {
  ChangeUnitStatusInput,
  CreateUnitInput,
  CreateUnitTypeInput,
  UpdateUnitInput,
  UpdateUnitTypeInput,
} from './schema.js';

// Prisma's Decimal doesn't serialize to a plain JSON number on its own
// (res.json() would emit its internal object shape) — every UnitType
// response goes through this so the API surface is always plain numbers.
function unitTypeToJson<T extends { baseRate: unknown; dayTourRate: unknown; extraPersonRate: unknown }>(
  unitType: T,
) {
  return {
    ...unitType,
    baseRate: Number(unitType.baseRate),
    dayTourRate: unitType.dayTourRate === null ? null : Number(unitType.dayTourRate),
    extraPersonRate: unitType.extraPersonRate === null ? null : Number(unitType.extraPersonRate),
  };
}

export async function listUnitTypes() {
  const unitTypes = await prisma.unitType.findMany({ where: { deletedAt: null }, orderBy: { sortOrder: 'asc' } });
  return unitTypes.map(unitTypeToJson);
}

export async function createUnitType(input: CreateUnitTypeInput) {
  const unitType = await prisma.unitType.create({ data: input });
  return unitTypeToJson(unitType);
}

export async function updateUnitType(id: string, input: UpdateUnitTypeInput) {
  const existing = await prisma.unitType.findFirst({ where: { id, deletedAt: null } });
  if (!existing) {
    throw new ApiError(404, 'NOT_FOUND', 'Unit type not found');
  }
  const unitType = await prisma.unitType.update({ where: { id }, data: input });
  return unitTypeToJson(unitType);
}

export interface UnitSummary {
  id: string;
  code: string;
  name: string;
  unitTypeId: string;
  type: string;
  capacity: number;
  floor: string | null;
  status: UnitStatusKey;
  version: number;
  notes: string | null;
  isActive: boolean;
  sortOrder: number;
}

export async function listUnits(): Promise<UnitSummary[]> {
  const units = await prisma.unit.findMany({
    where: { deletedAt: null },
    orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
  });
  return units.map((u) => ({ ...u, status: u.status as UnitStatusKey }));
}

export async function createUnit(input: CreateUnitInput) {
  const unitType = await prisma.unitType.findFirst({ where: { id: input.unitTypeId, deletedAt: null } });
  if (!unitType) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Unknown unitTypeId');
  }
  const existing = await prisma.unit.findFirst({ where: { code: input.code } });
  if (existing) {
    throw new ApiError(409, 'UNIT_CODE_TAKEN', `Unit code "${input.code}" is already in use`);
  }
  return prisma.unit.create({
    data: { ...input, capacity: input.capacity ?? unitType.defaultCapacity },
  });
}

export async function updateUnit(id: string, input: UpdateUnitInput) {
  const existing = await prisma.unit.findFirst({ where: { id, deletedAt: null } });
  if (!existing) {
    throw new ApiError(404, 'NOT_FOUND', 'Unit not found');
  }
  return prisma.unit.update({ where: { id }, data: input });
}

export async function getUnitTimeline(unitId: string) {
  const unit = await prisma.unit.findFirst({ where: { id: unitId, deletedAt: null } });
  if (!unit) {
    throw new ApiError(404, 'NOT_FOUND', 'Unit not found');
  }
  return prisma.unitStatusEvent.findMany({
    where: { unitId },
    orderBy: { createdAt: 'desc' },
    include: { actor: { select: { id: true, fullName: true, employeeCode: true } } },
  });
}

// Spec §7: "Implement each as an explicit transition table... The API
// validates against the table... Never duplicate this logic." This is
// the sole place a Unit's status actually changes outside seed/test data
// — every rule (which transitions exist, which permission each needs,
// optimistic-concurrency via `version`) is enforced here, once.
export async function changeUnitStatus(
  unitId: string,
  input: ChangeUnitStatusInput,
  actor: { id: string; roles: readonly RoleKey[]; permissions: Partial<Record<PermissionKey, PermissionScope>> },
  meta: { ip?: string | null; userAgent?: string | null } = {},
) {
  const unit = await prisma.unit.findFirst({ where: { id: unitId, deletedAt: null } });
  if (!unit) {
    throw new ApiError(404, 'NOT_FOUND', 'Unit not found');
  }

  const fromStatus = unit.status as UnitStatusKey;
  const transition = getTransition(fromStatus, input.toStatus);
  if (!transition) {
    throw new ApiError(422, 'INVALID_TRANSITION', `Cannot move a unit from ${fromStatus} to ${input.toStatus}`);
  }
  if (!actor.permissions[transition.permission]) {
    throw new ApiError(403, 'FORBIDDEN', `Missing permission: ${transition.permission}`);
  }

  // Manual transitions go through normally. The three "automatic" ones
  // (INSPECTED->READY, READY->OCCUPIED, OCCUPIED->VACANT_DIRTY) have no
  // real trigger yet — the inspection module (M3) and booking module
  // (M4) that are meant to call them don't exist — so without an escape
  // hatch a unit can get stuck with no way forward. SYSTEM_ADMIN only
  // (client decision, 2026-08-22, deliberately excluding RESORT_MANAGER:
  // this is a stopgap testing tool, not a normal operational path) may
  // override, and every use is audited distinctly (see below) so it's
  // visible later how often the override actually gets used — that
  // visibility is what tells us when M3/M4 have closed the gap for real.
  const isOverride = transition.trigger === 'automatic';
  if (isOverride && !canOverrideAutomaticTransition(actor.roles)) {
    throw new ApiError(
      422,
      'INVALID_TRANSITION',
      `${fromStatus} -> ${input.toStatus} happens automatically, not via manual status change`,
    );
  }

  const result = await prisma.unit.updateMany({
    where: { id: unitId, version: input.version },
    data: { status: input.toStatus, version: { increment: 1 } },
  });
  if (result.count === 0) {
    throw new ApiError(409, 'VERSION_CONFLICT', 'This unit was changed by someone else — refresh and try again.');
  }

  await prisma.unitStatusEvent.create({
    data: { unitId, fromStatus, toStatus: input.toStatus, actorId: actor.id, note: input.note },
  });

  if (isOverride) {
    // Distinct from the generic UPDATE row the audit extension already
    // wrote for the prisma.unit.updateMany() above — that row alone
    // wouldn't tell a future reader "this was the stopgap override
    // firing," just that status changed. This is the one that does.
    await logAudit({
      actorId: actor.id,
      action: 'UNIT_STATUS_AUTOMATIC_TRANSITION_OVERRIDE',
      entity: 'Unit',
      entityId: unitId,
      after: { fromStatus, toStatus: input.toStatus, note: input.note ?? null },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  }

  return { id: unitId, status: input.toStatus, version: input.version + 1 };
}

