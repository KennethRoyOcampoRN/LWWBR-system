import { EXCEPTION_ALERT_INCIDENT_TYPE, type IncidentStatusKey, type IncidentTypeKey } from '@lwwbr/shared';
import { prisma } from '../../lib/prisma.js';
import { generateReferenceNo } from '../../lib/referenceNo.js';
import { notifyUser } from '../notifications/service.js';
import type { CreateIncidentInput, ListIncidentsQuery } from './schema.js';

interface IncidentActor {
  id: string;
}

// Spec §8.3: "Push immediately only for: ... a safety incident."
// SAFETY-typed incidents notify every OWNER the moment they're created
// — see incident.ts's own comment on why SAFETY specifically, not the
// other four IncidentType values, and why no severity threshold gates
// this. Reuses the existing Notification model (notifyUser, from M3)
// rather than a second notification path, per spec.
async function notifyOwnersOfSafetyIncident(
  incident: { id: string; referenceNo: string; description: string },
  actorId: string,
): Promise<void> {
  const owners = await prisma.user.findMany({
    where: { isActive: true, deletedAt: null, roles: { some: { deletedAt: null, role: { key: 'OWNER' } } } },
    select: { id: true },
  });
  await Promise.all(
    owners.map((owner) =>
      notifyUser(owner.id, actorId, {
        type: 'SAFETY_INCIDENT',
        title: `Safety incident reported: ${incident.referenceNo}`,
        body: incident.description,
        entityType: 'Incident',
        entityId: incident.id,
      }),
    ),
  );
}

export async function createIncident(input: CreateIncidentInput, actor: IncidentActor) {
  const referenceNo = await generateReferenceNo('IC');

  const incident = await prisma.incident.create({
    data: {
      referenceNo,
      type: input.type,
      severity: input.severity,
      description: input.description,
      location: input.location,
      involvedUserId: input.involvedUserId,
      bookingId: input.bookingId,
      reportedById: actor.id,
    },
  });

  if ((incident.type as IncidentTypeKey) === EXCEPTION_ALERT_INCIDENT_TYPE) {
    await notifyOwnersOfSafetyIncident(incident, actor.id);
  }

  return incident;
}

export async function listIncidents(query: ListIncidentsQuery) {
  return prisma.incident.findMany({
    where: { deletedAt: null, ...(query.status ? { status: query.status as IncidentStatusKey } : {}) },
    include: { reportedBy: { select: { fullName: true } } },
    orderBy: [{ createdAt: 'desc' }],
  });
}
