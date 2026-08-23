import {
  canVerifyWorkOrder,
  DEFAULT_WORK_ORDER_PHOTO_REQUIREMENTS,
  getWorkOrderTransition,
  type DepartmentKey,
  type PermissionKey,
  type PermissionScope,
  type RoleKey,
  type WorkOrderPhotoKindKey,
  type WorkOrderStatusKey,
  type WorkOrderTypeKey,
} from '@lwwbr/shared';
import { getRealtimeAdapter } from '../../adapters/realtime/index.js';
import { getStorageAdapter } from '../../adapters/storage/index.js';
import { ApiError } from '../../lib/apiError.js';
import { logAudit } from '../../lib/auditLog.js';
import { prisma } from '../../lib/prisma.js';
import { generateReferenceNo } from '../../lib/referenceNo.js';
import type { AssignWorkOrderInput, ChangeWorkOrderStatusInput, CreateWorkOrderInput, ListWorkOrdersQuery } from './schema.js';

const PHOTO_REQUIREMENTS_SETTING_KEY = 'workOrder.photoRequirements';

type PhotoRequirements = Record<WorkOrderTypeKey, { onCreate: WorkOrderPhotoKindKey[]; onDone: WorkOrderPhotoKindKey[] }>;

// Spec §7.2.1: "Which types require which photo kinds lives in a Setting
// (workOrder.photoRequirements)... so the client can loosen or tighten
// it later without a deploy." Reads the live row; falls back to the
// shared default only if the row is somehow missing (never seeded, or
// deleted) — the gate must never go silently unenforced just because a
// Setting row doesn't exist yet.
async function getPhotoRequirements(): Promise<PhotoRequirements> {
  const setting = await prisma.setting.findUnique({ where: { key: PHOTO_REQUIREMENTS_SETTING_KEY } });
  if (!setting) {
    return DEFAULT_WORK_ORDER_PHOTO_REQUIREMENTS;
  }
  return setting.value as unknown as PhotoRequirements;
}

interface WorkOrderActor {
  id: string;
  department: string;
  roles: readonly RoleKey[];
  permissions: Partial<Record<PermissionKey, PermissionScope>>;
}

export async function createWorkOrder(input: CreateWorkOrderInput, actor: WorkOrderActor) {
  const requirements = await getPhotoRequirements();
  const requiredOnCreate = requirements[input.type]?.onCreate ?? [];
  for (const kind of requiredOnCreate) {
    if (!input.photos.some((p) => p.kind === kind)) {
      throw new ApiError(
        422,
        'PHOTO_REQUIRED',
        `A ${kind} photo is required to create a ${input.type} ticket.`,
        { kind },
      );
    }
  }

  if (input.photos.length > 0) {
    const fileIds = input.photos.map((p) => p.fileId);
    const files = await prisma.fileObject.findMany({ where: { id: { in: fileIds }, deletedAt: null } });
    if (files.length !== new Set(fileIds).size) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'One or more referenced photos could not be found.');
    }
  }

  const referenceNo = await generateReferenceNo('WO');

  const workOrder = await prisma.workOrder.create({
    data: {
      referenceNo,
      type: input.type,
      title: input.title,
      description: input.description,
      priority: input.priority,
      department: input.department,
      unitId: input.unitId,
      dueAt: input.dueAt ? new Date(input.dueAt) : undefined,
      createdById: actor.id,
      photos: {
        create: input.photos.map((p) => ({
          fileId: p.fileId,
          kind: p.kind,
          caption: p.caption,
          uploadedById: actor.id,
          capturedAt: new Date(),
        })),
      },
    },
    include: { photos: true },
  });

  try {
    // Spec §9.1: unmapped-yet event name, but same channel/pattern as
    // task 14's unit.status.changed — best-effort, never fails the
    // create itself. Urgent tickets additionally need a targeted
    // dept:{department} notification per spec §7.2 ("push a realtime
    // notification to everyone in the target department immediately")
    // — not yet built; this broadcast alone covers the property-wide
    // activity-feed use case task 15 (Command Center) will want.
    await getRealtimeAdapter().emit('property', 'workorder.created', {
      entityId: workOrder.id,
      actorId: actor.id,
      at: new Date().toISOString(),
      summary: `${workOrder.referenceNo} created — ${workOrder.title}`,
      department: workOrder.department,
      type: workOrder.type,
      priority: workOrder.priority,
    });
  } catch (error) {
    console.error('Realtime broadcast for workorder.created failed:', error);
  }

  return workOrder;
}

// Spec-derived read scoping (see rolePermissions.ts's own comment on why
// workorder:read is granted ALL-scope to every role: "everyone can
// create a ticket and 'My tasks' views need to read at least your own").
// workorder:read alone is the floor — own tickets only (created by or
// assigned to the caller). workorder:read_all is the elevated
// capability spec actually gates "see the department queue / everything"
// behind; its own scope value (ALL vs DEPARTMENT) decides how far that
// elevation reaches. This mirrors requirePermission's own contract: the
// middleware only confirms the caller holds *a* permission, "filtering
// query results... is the resource module's job."
function visibilityWhereClause(actor: WorkOrderActor) {
  const readAllScope = actor.permissions['workorder:read_all'];
  if (readAllScope === 'ALL') {
    return {};
  }
  if (readAllScope === 'DEPARTMENT') {
    return { department: actor.department as DepartmentKey };
  }
  return { OR: [{ createdById: actor.id }, { assignedToId: actor.id }] };
}

export async function listWorkOrders(query: ListWorkOrdersQuery, actor: WorkOrderActor) {
  return prisma.workOrder.findMany({
    where: {
      deletedAt: null,
      ...visibilityWhereClause(actor),
      ...(query.status ? { status: query.status } : {}),
      ...(query.department ? { department: query.department } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.unitId ? { unitId: query.unitId } : {}),
    },
    orderBy: [{ createdAt: 'desc' }],
    include: { unit: { select: { id: true, code: true, name: true } }, assignedTo: { select: { fullName: true } } },
  });
}

export async function getWorkOrder(id: string, actor: WorkOrderActor) {
  const workOrder = await prisma.workOrder.findFirst({
    where: { id, deletedAt: null },
    include: {
      unit: { select: { id: true, code: true, name: true } },
      createdBy: { select: { id: true, fullName: true } },
      assignedTo: { select: { id: true, fullName: true } },
      photos: { where: { deletedAt: null }, include: { file: true } },
      notes: { include: { author: { select: { fullName: true } } }, orderBy: { createdAt: 'asc' } },
    },
  });
  if (!workOrder) {
    throw new ApiError(404, 'NOT_FOUND', 'Work order not found');
  }

  const visible =
    actor.permissions['workorder:read_all'] === 'ALL' ||
    (actor.permissions['workorder:read_all'] === 'DEPARTMENT' && workOrder.department === actor.department) ||
    workOrder.createdById === actor.id ||
    workOrder.assignedToId === actor.id;
  if (!visible) {
    throw new ApiError(403, 'FORBIDDEN', 'You do not have access to this work order');
  }

  const storage = getStorageAdapter();
  const photosWithUrls = await Promise.all(
    workOrder.photos.map(async (photo) => ({
      id: photo.id,
      kind: photo.kind,
      caption: photo.caption,
      capturedAt: photo.capturedAt,
      attemptNo: photo.attemptNo,
      url: await storage.getSignedUrl(photo.file.storageKey),
    })),
  );

  return { ...workOrder, photos: photosWithUrls };
}

// §5.1: only SYSTEM_ADMIN/RESORT_MANAGER hold user:read, so a POC who
// holds workorder:assign (e.g. POC_MAINTENANCE) can't call GET /users to
// find someone to assign a ticket to. Rather than widen user:read's
// boundary, this is a narrowly-scoped list gated on workorder:assign
// itself, returning only the fields an assign-picker needs — not the
// general user directory.
export async function listAssignableUsers(department: string) {
  const users = await prisma.user.findMany({
    where: { department: department as DepartmentKey, isActive: true, deletedAt: null },
    select: { id: true, fullName: true, employeeCode: true },
    orderBy: { fullName: 'asc' },
  });
  return users;
}

export async function assignWorkOrder(
  id: string,
  input: AssignWorkOrderInput,
  actor: WorkOrderActor,
  meta: { ip?: string | null; userAgent?: string | null } = {},
) {
  const workOrder = await prisma.workOrder.findFirst({ where: { id, deletedAt: null } });
  if (!workOrder) {
    throw new ApiError(404, 'NOT_FOUND', 'Work order not found');
  }

  const fromStatus = workOrder.status as WorkOrderStatusKey;
  const transition = getWorkOrderTransition(fromStatus, 'ASSIGNED');
  if (!transition) {
    throw new ApiError(422, 'INVALID_TRANSITION', `Cannot assign a ticket from ${fromStatus}`);
  }
  if (!actor.permissions[transition.permission]) {
    throw new ApiError(403, 'FORBIDDEN', `Missing permission: ${transition.permission}`);
  }

  const assignee = await prisma.user.findFirst({
    where: { id: input.assignedToId, isActive: true, deletedAt: null },
  });
  if (!assignee) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Assignee not found or inactive');
  }

  const result = await prisma.workOrder.updateMany({
    where: { id, version: input.version },
    data: { status: 'ASSIGNED', assignedToId: input.assignedToId, assignedById: actor.id, version: { increment: 1 } },
  });
  if (result.count === 0) {
    throw new ApiError(409, 'VERSION_CONFLICT', 'This ticket was changed by someone else — refresh and try again.');
  }

  await logAudit({
    actorId: actor.id,
    action: 'WORKORDER_ASSIGNED',
    entity: 'WorkOrder',
    entityId: id,
    after: { assignedToId: input.assignedToId },
    ip: meta.ip,
    userAgent: meta.userAgent,
  });

  try {
    await getRealtimeAdapter().emit('property', 'workorder.status.changed', {
      entityId: id,
      actorId: actor.id,
      at: new Date().toISOString(),
      summary: `${workOrder.referenceNo} assigned to ${assignee.fullName}`,
      fromStatus,
      toStatus: 'ASSIGNED',
    });
  } catch (error) {
    console.error('Realtime broadcast for workorder.status.changed (assign) failed:', error);
  }

  return getWorkOrder(id, actor);
}

export async function changeWorkOrderStatus(
  id: string,
  input: ChangeWorkOrderStatusInput,
  actor: WorkOrderActor,
  meta: { ip?: string | null; userAgent?: string | null } = {},
) {
  const workOrder = await prisma.workOrder.findFirst({ where: { id, deletedAt: null } });
  if (!workOrder) {
    throw new ApiError(404, 'NOT_FOUND', 'Work order not found');
  }

  const fromStatus = workOrder.status as WorkOrderStatusKey;
  const transition = getWorkOrderTransition(fromStatus, input.toStatus);
  if (!transition) {
    throw new ApiError(422, 'INVALID_TRANSITION', `Cannot move a ticket from ${fromStatus} to ${input.toStatus}`);
  }
  if (!actor.permissions[transition.permission]) {
    throw new ApiError(403, 'FORBIDDEN', `Missing permission: ${transition.permission}`);
  }

  // Spec §7.2: "only the department POC or above may verify" — applies
  // to both DONE outcomes (VERIFIED and REOPENED), same QC check either
  // way. Not expressible as a resource-permission scope (it's a *which
  // department* question, not a *what resource* one) — see
  // canVerifyWorkOrder's own doc comment in packages/shared.
  if (input.toStatus === 'VERIFIED' || input.toStatus === 'REOPENED') {
    if (!canVerifyWorkOrder(actor.roles, actor.department, workOrder.department)) {
      throw new ApiError(403, 'FORBIDDEN', 'Only the department POC or above may verify this ticket');
    }
  }

  // Spec §7.2.1's mandatory-COMPLETION-photo gate on DONE — same pattern
  // as createWorkOrder's ISSUE-photo gate, read live from the same
  // Setting so the two gates can never drift out of sync.
  if (input.toStatus === 'DONE') {
    const requirements = await getPhotoRequirements();
    const requiredOnDone = requirements[workOrder.type as WorkOrderTypeKey]?.onDone ?? [];
    for (const kind of requiredOnDone) {
      if (!input.photos.some((p) => p.kind === kind)) {
        throw new ApiError(
          422,
          'PHOTO_REQUIRED',
          `A ${kind} photo is required to mark a ${workOrder.type} ticket done.`,
          { kind },
        );
      }
    }
    if (input.photos.length > 0) {
      const fileIds = input.photos.map((p) => p.fileId);
      const files = await prisma.fileObject.findMany({ where: { id: { in: fileIds }, deletedAt: null } });
      if (files.length !== new Set(fileIds).size) {
        throw new ApiError(422, 'VALIDATION_ERROR', 'One or more referenced photos could not be found.');
      }
    }
  }

  // §7.2: reopening sends the ticket back for another attempt — the
  // existing COMPLETION photos stay, tagged to the attempt that produced
  // them; the next DONE needs its own new COMPLETION photo, tagged to
  // the new attemptNo. attemptNo only ever increments on REOPENED.
  const nextAttemptNo = input.toStatus === 'REOPENED' ? workOrder.attemptNo + 1 : workOrder.attemptNo;

  const statusFields: Record<string, unknown> = { status: input.toStatus };
  if (input.toStatus === 'IN_PROGRESS' && fromStatus !== 'REOPENED') {
    statusFields.startedAt = new Date();
  }
  if (input.toStatus === 'DONE') {
    statusFields.completedAt = new Date();
  }
  if (input.toStatus === 'VERIFIED') {
    statusFields.verifiedById = actor.id;
    statusFields.verifiedAt = new Date();
  }
  if (input.toStatus === 'REOPENED') {
    statusFields.attemptNo = nextAttemptNo;
  }

  const result = await prisma.workOrder.updateMany({
    where: { id, version: input.version },
    data: { ...statusFields, version: { increment: 1 } },
  });
  if (result.count === 0) {
    throw new ApiError(409, 'VERSION_CONFLICT', 'This ticket was changed by someone else — refresh and try again.');
  }

  if (input.toStatus === 'DONE' && input.photos.length > 0) {
    await prisma.workOrderPhoto.createMany({
      data: input.photos.map((p) => ({
        workOrderId: id,
        fileId: p.fileId,
        kind: p.kind,
        caption: p.caption,
        uploadedById: actor.id,
        capturedAt: new Date(),
        attemptNo: workOrder.attemptNo,
      })),
    });
  }

  if (input.note) {
    await prisma.workOrderNote.create({
      data: { workOrderId: id, authorId: actor.id, body: input.note },
    });
  }

  if (input.toStatus === 'VERIFIED' || input.toStatus === 'REOPENED') {
    // Distinct from the generic UPDATE row the audit extension already
    // wrote for the updateMany() above — this one names the QC outcome
    // explicitly, same reasoning as the unit module's automatic-override
    // audit entry.
    await logAudit({
      actorId: actor.id,
      action: input.toStatus === 'VERIFIED' ? 'WORKORDER_VERIFIED' : 'WORKORDER_REOPENED',
      entity: 'WorkOrder',
      entityId: id,
      after: { fromStatus, toStatus: input.toStatus, note: input.note ?? null },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  }

  try {
    // Deferred gap, flagged rather than silently omitted: this broadcast
    // covers the activity-feed use case (same channel/pattern as
    // workorder.created and the unit module's status broadcast), but
    // there's no targeted per-assignee "your ticket moved" notification
    // yet — out of scope for this slice.
    await getRealtimeAdapter().emit('property', 'workorder.status.changed', {
      entityId: id,
      actorId: actor.id,
      at: new Date().toISOString(),
      summary: `${workOrder.referenceNo} ${fromStatus} -> ${input.toStatus}`,
      fromStatus,
      toStatus: input.toStatus,
    });
  } catch (error) {
    console.error('Realtime broadcast for workorder.status.changed failed:', error);
  }

  return getWorkOrder(id, actor);
}
