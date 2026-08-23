import {
  DEFAULT_WORK_ORDER_PHOTO_REQUIREMENTS,
  type DepartmentKey,
  type PermissionKey,
  type PermissionScope,
  type WorkOrderPhotoKindKey,
  type WorkOrderTypeKey,
} from '@lwwbr/shared';
import { getRealtimeAdapter } from '../../adapters/realtime/index.js';
import { getStorageAdapter } from '../../adapters/storage/index.js';
import { ApiError } from '../../lib/apiError.js';
import { prisma } from '../../lib/prisma.js';
import { generateReferenceNo } from '../../lib/referenceNo.js';
import type { CreateWorkOrderInput, ListWorkOrdersQuery } from './schema.js';

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
