import { ApiError } from '../../lib/apiError.js';
import { prisma } from '../../lib/prisma.js';
import type { CreateShiftInput, ListShiftsQuery, UpdateShiftInput } from './schema.js';

const SHIFT_INCLUDE = { user: { select: { id: true, fullName: true } } } as const;

// Client-directed feature, 2026-09-18: shift roster, using the existing
// Shift model exactly as-is — no schema change. isReliever is a bare
// flag with no relation to another shift/employee, so "reliever
// assignment" here genuinely is just marking a shift as covering for
// someone, surfaced as a badge/filter; tracking *who* it covers for
// would need a real relation this ask didn't request.
export async function createShift(input: CreateShiftInput) {
  const shift = await prisma.shift.create({
    data: {
      userId: input.userId,
      date: new Date(input.date),
      startTime: new Date(input.startTime),
      endTime: new Date(input.endTime),
      department: input.department,
      isReliever: input.isReliever ?? false,
      note: input.note,
    },
    include: SHIFT_INCLUDE,
  });
  return shift;
}

export async function updateShift(id: string, input: UpdateShiftInput) {
  const existing = await prisma.shift.findFirst({ where: { id, deletedAt: null } });
  if (!existing) {
    throw new ApiError(404, 'NOT_FOUND', 'Shift not found');
  }
  const shift = await prisma.shift.update({
    where: { id },
    data: {
      ...(input.date ? { date: new Date(input.date) } : {}),
      ...(input.startTime ? { startTime: new Date(input.startTime) } : {}),
      ...(input.endTime ? { endTime: new Date(input.endTime) } : {}),
      ...(input.department ? { department: input.department } : {}),
      ...(input.isReliever === undefined ? {} : { isReliever: input.isReliever }),
      ...(input.note === undefined ? {} : { note: input.note }),
    },
    include: SHIFT_INCLUDE,
  });
  return shift;
}

// Client follow-up, 2026-09-18: a soft-delete/cancel action so a
// mistaken roster entry can actually be corrected — matches spec §4.5's
// own default ("nothing is hard-deleted from the UI"), unlike the
// deliberate Option-B hard-delete exceptions on MenuItem/AmenityItem.
// Nothing else in the schema references Shift.id, so there's no history
// to check or block on — a plain deletedAt set is sufficient.
export async function deleteShift(id: string) {
  const existing = await prisma.shift.findFirst({ where: { id, deletedAt: null } });
  if (!existing) {
    throw new ApiError(404, 'NOT_FOUND', 'Shift not found');
  }
  await prisma.shift.update({ where: { id }, data: { deletedAt: new Date() } });
}

// Gated on shift:manage itself (not user:read) — same reasoning as
// workorders/service.ts's listAssignableUsers: most shift:manage holders
// (POC_HOUSEKEEPING, POC_MAINTENANCE, ADMIN_HEAD, RESTAURANT_MANAGER,
// OPS_SAFETY_SUPERVISOR) don't hold user:read (confirmed against the
// real seed), so the roster's "assign to" picker can't depend on the
// general user directory endpoint.
export async function listAssignableUsers() {
  const users = await prisma.user.findMany({
    where: { isActive: true, deletedAt: null },
    select: { id: true, fullName: true, employeeCode: true, department: true },
    orderBy: { fullName: 'asc' },
  });
  return users;
}

export async function listShifts(query: ListShiftsQuery) {
  const shifts = await prisma.shift.findMany({
    where: {
      deletedAt: null,
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.from || query.to
        ? {
            date: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    },
    include: SHIFT_INCLUDE,
    orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
  });
  return shifts;
}
