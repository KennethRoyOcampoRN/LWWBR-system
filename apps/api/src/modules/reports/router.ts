import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { requirePermission } from '../auth/requirePermission.js';
import { reportExportQuerySchema, reportKeyParamSchema, reportQuerySchema } from './schema.js';
import { getReport, getReportCsv } from './service.js';

export const reportsRouter = Router();

// Spec §9: `GET /reports/:key?from=&to=&department=`. report:view gates
// reading a report on screen; report:export (a separate, narrower grant
// per the role matrix — e.g. RESTAURANT_MANAGER has report:view but not
// report:export at ALL scope... actually holds report:export ALL per
// rolePermissions.ts, see that file — POC_HOUSEKEEPING/POC_MAINTENANCE
// hold report:view only, no report:export at all) gates the CSV route
// below.
reportsRouter.get(
  '/reports/:key',
  requirePermission('report:view'),
  asyncHandler(async (req, res) => {
    const { key } = reportKeyParamSchema.parse(req.params);
    const query = reportQuerySchema.parse(req.query);
    const report = await getReport(key, query, {
      department: req.authUser!.department,
      permissions: req.authUser!.permissions,
    });
    res.status(200).json({ report: { key, from: query.from, to: query.to, ...report } });
  }),
);

reportsRouter.get(
  '/reports/:key/export',
  requirePermission('report:export'),
  asyncHandler(async (req, res) => {
    const { key } = reportKeyParamSchema.parse(req.params);
    const query = reportExportQuerySchema.parse(req.query);
    const csv = await getReportCsv(key, query, {
      department: req.authUser!.department,
      permissions: req.authUser!.permissions,
    });
    res.status(200);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${key}-${query.from}-to-${query.to}.csv"`);
    res.send(csv);
  }),
);
