import { INCIDENT_SEVERITY_KEYS, INCIDENT_STATUS_KEYS, INCIDENT_TYPE_KEYS } from '@lwwbr/shared';
import { z } from 'zod';

export const createIncidentSchema = z.object({
  type: z.enum(INCIDENT_TYPE_KEYS),
  severity: z.enum(INCIDENT_SEVERITY_KEYS),
  description: z.string().trim().min(1).max(2000),
  location: z.string().trim().max(200).optional(),
  involvedUserId: z.string().min(1).optional(),
  bookingId: z.string().min(1).optional(),
});

export type CreateIncidentInput = z.infer<typeof createIncidentSchema>;

export const listIncidentsQuerySchema = z.object({
  status: z.enum(INCIDENT_STATUS_KEYS).optional(),
});

export type ListIncidentsQuery = z.infer<typeof listIncidentsQuerySchema>;
