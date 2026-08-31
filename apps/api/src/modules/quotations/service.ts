import { ApiError } from '../../lib/apiError.js';
import { prisma } from '../../lib/prisma.js';
import { generateReferenceNo } from '../../lib/referenceNo.js';
import type {
  ChangeQuotationRequestStatusInput,
  CreateQuotationRequestInput,
  ListQuotationRequestsQuery,
} from './schema.js';

interface QuotationRequestActor {
  id: string;
}

const QUOTATION_REQUEST_INCLUDE = {
  createdBy: { select: { id: true, fullName: true } },
  updatedBy: { select: { id: true, fullName: true } },
} as const;

export async function createQuotationRequest(input: CreateQuotationRequestInput, actor: QuotationRequestActor) {
  const referenceNo = await generateReferenceNo('QT');

  return prisma.quotationRequest.create({
    data: {
      referenceNo,
      name: input.name,
      contactNumber: input.contactNumber,
      email: input.email,
      pax: input.pax,
      checkInDate: new Date(input.checkInDate),
      checkOutDate: new Date(input.checkOutDate),
      note: input.note,
      createdById: actor.id,
    },
    include: QUOTATION_REQUEST_INCLUDE,
  });
}

export async function listQuotationRequests(query: ListQuotationRequestsQuery) {
  return prisma.quotationRequest.findMany({
    where: { deletedAt: null, ...(query.status ? { status: query.status } : {}) },
    include: QUOTATION_REQUEST_INCLUDE,
    orderBy: [{ createdAt: 'desc' }],
  });
}

// Just two states — PENDING/DONE, gated by the single
// quotation:update_status permission (SYSTEM_ADMIN only). No transition
// table needed for a straight two-way toggle.
export async function changeQuotationRequestStatus(
  id: string,
  input: ChangeQuotationRequestStatusInput,
  actor: QuotationRequestActor,
) {
  const existing = await prisma.quotationRequest.findFirst({ where: { id, deletedAt: null } });
  if (!existing) {
    throw new ApiError(404, 'NOT_FOUND', 'Quotation request not found');
  }

  return prisma.quotationRequest.update({
    where: { id },
    data: { status: input.toStatus, updatedById: actor.id },
    include: QUOTATION_REQUEST_INCLUDE,
  });
}
