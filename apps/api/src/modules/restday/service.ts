import { ApiError } from '../../lib/apiError.js';
import { prisma } from '../../lib/prisma.js';
import type {
  ChangeRestDayRequestStatusInput,
  CreateRestDayRequestInput,
  ListRestDayRequestsQuery,
} from './schema.js';

interface RestDayActor {
  id: string;
  canApprove: boolean;
}

const REST_DAY_INCLUDE = {
  user: { select: { id: true, fullName: true } },
  decidedBy: { select: { id: true, fullName: true } },
} as const;

// Client-directed feature, 2026-09-18: rest-day requests, using the
// existing RestDayRequest model as-is. restday:request is a near-
// universal grant (every role but OWNER), so creation is self-scoped
// only — the caller can only ever submit a request for themselves.
export async function createRestDayRequest(input: CreateRestDayRequestInput, actor: { id: string }) {
  const request = await prisma.restDayRequest.create({
    data: { userId: actor.id, requestedDate: new Date(input.requestedDate), reason: input.reason },
    include: REST_DAY_INCLUDE,
  });
  return request;
}

// A restday:approve holder sees the full queue (or their own via
// ?mine=true); a restday:request-only holder always sees only their own
// requests, regardless of query params — the query can't be used to see
// someone else's submissions without also holding restday:approve.
export async function listRestDayRequests(query: ListRestDayRequestsQuery, actor: RestDayActor) {
  const scopedToSelf = !actor.canApprove || query.mine;
  const requests = await prisma.restDayRequest.findMany({
    where: {
      deletedAt: null,
      ...(query.status ? { status: query.status } : {}),
      ...(scopedToSelf ? { userId: actor.id } : {}),
    },
    include: REST_DAY_INCLUDE,
    orderBy: [{ createdAt: 'desc' }],
  });
  return requests;
}

export async function changeRestDayRequestStatus(
  id: string,
  input: ChangeRestDayRequestStatusInput,
  actor: { id: string },
) {
  const existing = await prisma.restDayRequest.findFirst({ where: { id, deletedAt: null } });
  if (!existing) {
    throw new ApiError(404, 'NOT_FOUND', 'Rest-day request not found');
  }
  const request = await prisma.restDayRequest.update({
    where: { id },
    data: {
      status: input.toStatus,
      decidedById: actor.id,
      decidedAt: new Date(),
      decisionNote: input.decisionNote,
    },
    include: REST_DAY_INCLUDE,
  });
  return request;
}
