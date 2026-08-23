import {
  DEPARTMENT_KEYS,
  WORK_ORDER_PHOTO_KIND_KEYS,
  WORK_ORDER_PRIORITY_KEYS,
  WORK_ORDER_STATUS_KEYS,
  WORK_ORDER_TYPE_KEYS,
} from '@lwwbr/shared';
import { z } from 'zod';

const photoRefSchema = z.object({
  fileId: z.string().min(1),
  kind: z.enum(WORK_ORDER_PHOTO_KIND_KEYS),
  caption: z.string().trim().max(500).optional(),
});

export const createWorkOrderSchema = z.object({
  type: z.enum(WORK_ORDER_TYPE_KEYS),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  priority: z.enum(WORK_ORDER_PRIORITY_KEYS).default('NORMAL'),
  department: z.enum(DEPARTMENT_KEYS),
  unitId: z.string().min(1).optional(),
  dueAt: z.string().datetime().optional(),
  // §7.2.1's mandatory-ISSUE-photo gate reads this array against the
  // live workOrder.photoRequirements Setting — see service.ts. Photos
  // are uploaded separately first (POST /files) and referenced here by
  // id, not embedded as raw bytes in this request.
  photos: z.array(photoRefSchema).max(6).default([]),
});

export type CreateWorkOrderInput = z.infer<typeof createWorkOrderSchema>;

export const listWorkOrdersQuerySchema = z.object({
  status: z.enum(WORK_ORDER_STATUS_KEYS).optional(),
  department: z.enum(DEPARTMENT_KEYS).optional(),
  type: z.enum(WORK_ORDER_TYPE_KEYS).optional(),
  unitId: z.string().min(1).optional(),
});

export type ListWorkOrdersQuery = z.infer<typeof listWorkOrdersQuerySchema>;

export const assignWorkOrderSchema = z.object({
  assignedToId: z.string().min(1),
  version: z.number().int().nonnegative(),
});

export type AssignWorkOrderInput = z.infer<typeof assignWorkOrderSchema>;

// Spec §7.2: "DONE -> REOPENED when QC fails; require a note." Every
// other transition's note stays optional (matching the unit module's
// changeUnitStatusSchema pattern) — REOPENED is the one place spec
// itself makes it mandatory, enforced with `.refine()` since it's
// conditional on `toStatus`, not expressible as a plain required field.
export const changeWorkOrderStatusSchema = z
  .object({
    toStatus: z.enum(WORK_ORDER_STATUS_KEYS),
    version: z.number().int().nonnegative(),
    note: z.string().trim().max(2000).optional(),
    // Only meaningful when toStatus is DONE (§7.2.1's mandatory-
    // COMPLETION-photo gate, checked in service.ts against the live
    // Setting) — harmless if sent for any other transition, since
    // nothing reads it outside that one case.
    photos: z.array(photoRefSchema).max(6).default([]),
  })
  .refine((data) => data.toStatus !== 'REOPENED' || (data.note && data.note.length > 0), {
    message: 'A note is required when reopening a ticket',
    path: ['note'],
  });

export type ChangeWorkOrderStatusInput = z.infer<typeof changeWorkOrderStatusSchema>;
