import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { requirePermission } from '../auth/requirePermission.js';
import { createIncidentSchema, listIncidentsQuerySchema } from './schema.js';
import { createIncident, listIncidents } from './service.js';

export const incidentsRouter = Router();

// Spec §5.3: `incident:create` is broadly seeded — reporting an incident
// (spec §8.3's "report an incident button") isn't a privileged action,
// unlike reading the incident log (`incident:read`, oversight roles
// only). Minimal module — see incidents/service.ts's own header comment
// for scope (just enough for the safety-incident exception alert and a
// real digest count, not the full §8.3 incident/policy log).
incidentsRouter.post(
  '/incidents',
  requirePermission('incident:create'),
  asyncHandler(async (req, res) => {
    const body = createIncidentSchema.parse(req.body);
    const incident = await createIncident(body, { id: req.authUser!.id });
    res.status(201).json({ incident });
  }),
);

incidentsRouter.get(
  '/incidents',
  requirePermission('incident:read'),
  asyncHandler(async (req, res) => {
    const query = listIncidentsQuerySchema.parse(req.query);
    res.status(200).json({ incidents: await listIncidents(query) });
  }),
);
