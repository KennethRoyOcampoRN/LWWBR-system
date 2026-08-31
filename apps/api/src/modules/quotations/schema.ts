import { QUOTATION_STATUS_KEYS } from '@lwwbr/shared';
import { z } from 'zod';

// Client-directed feature, 2026-08-31: a standalone quotation-request
// record (a prospective guest asking for a rate quote before booking) —
// no relation to Booking/Unit, since there's no reservation yet.
export const createQuotationRequestSchema = z.object({
  name: z.string().trim().min(1).max(200),
  contactNumber: z.string().trim().min(1).max(50),
  email: z.string().trim().email(),
  pax: z.number().int().positive(),
  checkInDate: z.string().datetime(),
  checkOutDate: z.string().datetime(),
  note: z.string().trim().max(2000).optional(),
});

export type CreateQuotationRequestInput = z.infer<typeof createQuotationRequestSchema>;

export const listQuotationRequestsQuerySchema = z.object({
  status: z.enum(QUOTATION_STATUS_KEYS).optional(),
});

export type ListQuotationRequestsQuery = z.infer<typeof listQuotationRequestsQuerySchema>;

// Just two states, no third option, per the client's own spec.
export const changeQuotationRequestStatusSchema = z.object({
  toStatus: z.enum(QUOTATION_STATUS_KEYS),
});

export type ChangeQuotationRequestStatusInput = z.infer<typeof changeQuotationRequestStatusSchema>;
