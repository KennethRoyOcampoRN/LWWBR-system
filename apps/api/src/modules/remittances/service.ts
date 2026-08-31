import { getStorageAdapter } from '../../adapters/storage/index.js';
import { ApiError } from '../../lib/apiError.js';
import { prisma } from '../../lib/prisma.js';
import { generateReferenceNo } from '../../lib/referenceNo.js';
import type {
  ChangeRemittanceRequestStatusInput,
  CreateRemittanceRequestInput,
  ListRemittanceRequestsQuery,
} from './schema.js';

interface RemittanceRequestActor {
  id: string;
}

const REMITTANCE_REQUEST_INCLUDE = {
  proofFile: { select: { id: true, filename: true, mimeType: true, storageKey: true } },
  createdBy: { select: { id: true, fullName: true } },
  verifiedBy: { select: { id: true, fullName: true } },
} as const;

type RawRemittanceRequest = {
  amount: unknown;
  proofFile: { id: string; filename: string; mimeType: string; storageKey: string } | null;
};

// Prisma's Decimal doesn't serialize to a plain JSON number on its own —
// same reasoning and pattern as amenities/service.ts's amenityItemToJson.
// proofFile.storageKey never leaves this function: same reasoning as
// workorders/service.ts's getWorkOrder — there is no generic GET
// /files/:id route (see files/router.ts's own comment on why), so the
// only way a caller can ever actually view the photo is a real signed
// URL generated here, not the raw storage key.
async function remittanceRequestToJson<T extends RawRemittanceRequest>(request: T) {
  const { proofFile, ...rest } = request;
  return {
    ...rest,
    amount: Number(request.amount),
    proofFile: proofFile
      ? {
          id: proofFile.id,
          filename: proofFile.filename,
          mimeType: proofFile.mimeType,
          url: await getStorageAdapter().getSignedUrl(proofFile.storageKey),
        }
      : null,
  };
}

export async function createRemittanceRequest(input: CreateRemittanceRequestInput, actor: RemittanceRequestActor) {
  if (input.proofFileId) {
    const file = await prisma.fileObject.findFirst({ where: { id: input.proofFileId, deletedAt: null } });
    if (!file) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'The referenced proof photo could not be found.');
    }
  }

  const referenceNo = await generateReferenceNo('RM');

  const request = await prisma.remittanceRequest.create({
    data: {
      referenceNo,
      name: input.name,
      date: new Date(input.date),
      modeOfPayment: input.modeOfPayment,
      amount: input.amount,
      referenceNumber: input.referenceNumber,
      proofFileId: input.proofFileId,
      createdById: actor.id,
    },
    include: REMITTANCE_REQUEST_INCLUDE,
  });

  return remittanceRequestToJson(request);
}

export async function listRemittanceRequests(query: ListRemittanceRequestsQuery) {
  const requests = await prisma.remittanceRequest.findMany({
    where: { deletedAt: null, ...(query.status ? { status: query.status } : {}) },
    include: REMITTANCE_REQUEST_INCLUDE,
    orderBy: [{ createdAt: 'desc' }],
  });
  return Promise.all(requests.map(remittanceRequestToJson));
}

export interface PendingRemittance {
  id: string;
  referenceNo: string;
  name: string;
  waitingMinutes: number;
}

// Command Center attention-queue row, 2026-08-31: same "how long has this
// been sitting" framing as listOverdueAmenityRequests' overdueMinutes,
// computed from createdAt since a remittance request has no SLA/due-back
// field of its own to compare against — it's either FOR_VERIFICATION or
// it isn't. Deliberately does NOT reuse listRemittanceRequests (which
// returns the full row including a signed proof-photo URL): the
// dashboard only needs a light summary, and generating a signed URL for
// every pending request on every Command Center load would be wasted
// work for data the queue row never displays.
export async function listPendingRemittances(): Promise<PendingRemittance[]> {
  const now = Date.now();
  const requests = await prisma.remittanceRequest.findMany({
    where: { deletedAt: null, status: 'FOR_VERIFICATION' },
    select: { id: true, referenceNo: true, name: true, createdAt: true },
    orderBy: [{ createdAt: 'asc' }],
  });
  return requests.map((request) => ({
    id: request.id,
    referenceNo: request.referenceNo,
    name: request.name,
    waitingMinutes: Math.floor((now - request.createdAt.getTime()) / 60_000),
  }));
}

// Bidirectional: OWNER (the only remittance:verify holder) can mark
// VERIFIED or revert to FOR_VERIFICATION — both directions are the same
// write, gated by the same single permission, so there's no transition
// table to consult, unlike AmenityRequest's multi-step, multi-permission
// lifecycle. Reverting clears verifiedBy/verifiedAt rather than leaving a
// stale verifier attached to a request that's no longer verified.
export async function changeRemittanceRequestStatus(
  id: string,
  input: ChangeRemittanceRequestStatusInput,
  actor: RemittanceRequestActor,
) {
  const existing = await prisma.remittanceRequest.findFirst({ where: { id, deletedAt: null } });
  if (!existing) {
    throw new ApiError(404, 'NOT_FOUND', 'Remittance request not found');
  }

  const updated = await prisma.remittanceRequest.update({
    where: { id },
    data:
      input.toStatus === 'VERIFIED'
        ? { status: 'VERIFIED', verifiedById: actor.id, verifiedAt: new Date() }
        : { status: 'FOR_VERIFICATION', verifiedById: null, verifiedAt: null },
    include: REMITTANCE_REQUEST_INCLUDE,
  });

  return remittanceRequestToJson(updated);
}
