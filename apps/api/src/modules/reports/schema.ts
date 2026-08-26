import { DEPARTMENT_KEYS, REPORT_KEYS } from '@lwwbr/shared';
import { z } from 'zod';

// Spec §9's declared surface (`GET /reports/:key?from=&to=&department=`)
// takes from/to/department as generic query params shared across every
// report key — but not every report has a department axis (occupancy is
// property-wide; see service.ts's own comment on why a DEPARTMENT-scoped
// report:view holder is refused that key entirely). `department` stays
// optional and report-specific service functions decide whether to use
// it.
export const reportQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'from must be YYYY-MM-DD'),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'to must be YYYY-MM-DD'),
  department: z.enum(DEPARTMENT_KEYS).optional(),
});

export type ReportQuery = z.infer<typeof reportQuerySchema>;

export const reportKeyParamSchema = z.object({
  key: z.enum(REPORT_KEYS),
});

export const reportExportQuerySchema = reportQuerySchema.extend({
  format: z.literal('csv'),
});
