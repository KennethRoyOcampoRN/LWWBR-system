import { DEPARTMENT_KEYS, WORK_ORDER_PHOTO_KIND_KEYS, WORK_ORDER_PRIORITY_KEYS, WORK_ORDER_TYPE_KEYS } from '@lwwbr/shared';
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
  status: z
    .enum(['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'DONE', 'VERIFIED', 'REOPENED', 'CANCELLED'])
    .optional(),
  department: z.enum(DEPARTMENT_KEYS).optional(),
  type: z.enum(WORK_ORDER_TYPE_KEYS).optional(),
  unitId: z.string().min(1).optional(),
});

export type ListWorkOrdersQuery = z.infer<typeof listWorkOrdersQuerySchema>;
