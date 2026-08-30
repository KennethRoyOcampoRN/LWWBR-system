import { prisma } from '../../lib/prisma.js';
import { notifyUser } from '../notifications/service.js';
import { listUrgentSlaBreachedWorkOrders } from '../workorders/service.js';

// Spec §8.3: "Push immediately only for: an urgent work order open past
// its SLA, a forced check-out with an outstanding balance, a cash
// variance beyond a threshold, and a safety incident. Everything else
// waits for the digest." Only the first and last of those four are
// buildable today — see spec.md §13 decision 7: forced-checkout-balance
// and cash-variance both depend on Payment/Folio/CashCount tracking that
// was never built and is explicitly out of scope. The safety-incident
// alert is event-driven (fires on Incident creation — see
// incidents/service.ts) and needs no sweep. This sweep covers the one
// remaining trigger that genuinely needs one: SLA breach is a
// time-threshold condition, not something a user action fires, so
// there's no event to hook — the only way to detect "just crossed
// dueAt" in a serverless app is to check periodically, same as the
// amenity-overdue sweep this mirrors.
//
// Dedup: a work order stays breached (and stays in
// listUrgentSlaBreachedWorkOrders's result) on every sweep run until
// it's closed or its dueAt changes, so without a check this would
// re-alert on every 15-minute tick. Before alerting, check whether a
// WORKORDER_SLA_BREACHED Notification already exists for that ticket —
// no schema change needed, reuses the same Notification rows the alert
// itself writes. One dedup check per ticket, not per (ticket, owner)
// pair: a new OWNER added after the first alert doesn't get a
// historical catch-up, which is an acceptable simplification for an
// "immediate" exception alert, not the digest's full daily record.
export async function runExceptionAlertsSweep(): Promise<{ alertedCount: number }> {
  const breached = await listUrgentSlaBreachedWorkOrders();
  if (breached.length === 0) {
    return { alertedCount: 0 };
  }

  const owners = await prisma.user.findMany({
    where: { isActive: true, deletedAt: null, roles: { some: { deletedAt: null, role: { key: 'OWNER' } } } },
    select: { id: true },
  });
  if (owners.length === 0) {
    return { alertedCount: 0 };
  }

  let alertedCount = 0;
  for (const wo of breached) {
    const alreadyAlerted = await prisma.notification.findFirst({
      where: { type: 'WORKORDER_SLA_BREACHED', entityType: 'WorkOrder', entityId: wo.id },
    });
    if (alreadyAlerted) continue;

    await Promise.all(
      owners.map((owner) =>
        // 'system' actorId: this alert has no human actor — it fires from
        // a time threshold, not a user action. Never persisted on the
        // Notification row itself (see notifyUser), only carried in the
        // realtime broadcast payload, so this is harmless metadata, not
        // an audit-trail gap.
        notifyUser(owner.id, 'system', {
          type: 'WORKORDER_SLA_BREACHED',
          title: `Urgent work order past SLA: ${wo.referenceNo}`,
          body: `${wo.title}${wo.unitCode ? ` (${wo.unitCode})` : ''} — ${wo.overdueMinutes} minutes overdue.`,
          entityType: 'WorkOrder',
          entityId: wo.id,
        }),
      ),
    );
    alertedCount += 1;
  }

  return { alertedCount };
}
