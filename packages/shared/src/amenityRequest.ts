import type { PermissionKey } from './permissions.js';

// Spec §7.4's amenity request lifecycle:
//   REQUESTED -> APPROVED -> ISSUED -> RETURNED
//                   |           |
//               CANCELLED   OVERDUE -> RETURNED | LOST_DAMAGED
// Mirrors the Prisma `AmenityRequestStatus` enum. Same "explicit
// transition table in packages/shared" pattern as unitStatus.ts/
// workOrder.ts — the API validates against it, a future UI derives its
// action buttons from it, never duplicated.
//
// REQUESTED -> CANCELLED is not literally drawn in spec's diagram (the
// CANCELLED arrow is drawn from APPROVED only) but is added here by the
// same reasoning already confirmed by the client for WorkOrder's
// OPEN -> CANCELLED gap (see workOrder.ts's own header comment): an
// unapproved request needs a way to be withdrawn — a duplicate or
// mistaken request shouldn't have to wait for someone to approve it
// first just to cancel it. This is a documented judgment call, not a
// client confirmation like the work-order case — flagged here and in the
// session report rather than silently assumed.
//
// ISSUED -> OVERDUE is deliberately NOT in this table at all: it's the
// one truly automatic transition (spec §7.4: "auto-flips... via POST
// /api/v1/jobs/amenity-overdue"), driven exclusively by the sweep job
// (see amenities/service.ts's applyAmenityOverdueSweep), never by a user
// through the manual status-change endpoint — same reasoning as units'
// automatic transitions bypassing getTransition() entirely rather than
// appearing in the manual table with a permission gate.
export const AMENITY_REQUEST_STATUS_KEYS = [
  'REQUESTED',
  'APPROVED',
  'ISSUED',
  'RETURNED',
  'OVERDUE',
  'CANCELLED',
  'LOST_DAMAGED',
] as const;

export type AmenityRequestStatusKey = (typeof AMENITY_REQUEST_STATUS_KEYS)[number];

export interface AmenityRequestTransition {
  to: AmenityRequestStatusKey;
  permission: PermissionKey;
}

// Permission choices, reasoned through since spec names the target
// states but not every gate explicitly:
// - REQUESTED -> APPROVED, REQUESTED -> CANCELLED, APPROVED -> CANCELLED:
//   `amenity:approve` — the reviewer decision (approve or reject/
//   withdraw) is the same capability either way. Confirmed safe: every
//   seeded role holding `amenity:request` also holds `amenity:approve`
//   (see rolePermissions.ts), so gating cancellation on the approve key
//   never locks a requester out of withdrawing their own request.
// - APPROVED -> ISSUED: `amenity:issue`, spec's own naming — the
//   requiresDeposit gate (spec: "cannot move to ISSUED without a
//   recorded deposit amount") is enforced separately in the service
//   layer, same pattern as work orders' mandatory-photo gate not being
//   encoded as a transition permission either.
// - ISSUED -> RETURNED, OVERDUE -> RETURNED, OVERDUE -> LOST_DAMAGED:
//   `amenity:return`, spec's own naming for the return-side capability.
export const AMENITY_REQUEST_TRANSITIONS: Record<AmenityRequestStatusKey, AmenityRequestTransition[]> = {
  REQUESTED: [
    { to: 'APPROVED', permission: 'amenity:approve' },
    { to: 'CANCELLED', permission: 'amenity:approve' },
  ],
  APPROVED: [
    { to: 'ISSUED', permission: 'amenity:issue' },
    { to: 'CANCELLED', permission: 'amenity:approve' },
  ],
  ISSUED: [{ to: 'RETURNED', permission: 'amenity:return' }],
  OVERDUE: [
    { to: 'RETURNED', permission: 'amenity:return' },
    { to: 'LOST_DAMAGED', permission: 'amenity:return' },
  ],
  RETURNED: [],
  CANCELLED: [],
  LOST_DAMAGED: [],
};

export function getAmenityRequestTransition(
  from: AmenityRequestStatusKey,
  to: AmenityRequestStatusKey,
): AmenityRequestTransition | undefined {
  return (AMENITY_REQUEST_TRANSITIONS[from] ?? []).find((t) => t.to === to);
}

export function allowedAmenityRequestTransitions(
  from: AmenityRequestStatusKey,
  permissions: Partial<Record<PermissionKey, unknown>>,
): AmenityRequestStatusKey[] {
  return (AMENITY_REQUEST_TRANSITIONS[from] ?? []).filter((t) => permissions[t.permission]).map((t) => t.to);
}
