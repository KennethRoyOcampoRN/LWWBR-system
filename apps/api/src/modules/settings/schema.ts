import { z } from 'zod';

// Build plan stage 2 (spec.md §13 decision 13, 2026-11-04): the resort-
// identity fields a Receipt's header snapshot is sourced from. Address
// and name are required — a Receipt can't print a blank header line —
// everything else on the sample is optional (Cell No./Contact No./
// Website/Facebook each appeared on their own line; not every resort
// necessarily has all four). `logoFileId` is a separate field, not part
// of this same text form in the UI (uploaded via the existing generic
// POST /files, then PATCHed in here as the resulting file id) but
// validated and stored the same way as every other field.
export const resortIdentityInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  address: z.string().trim().min(1).max(500),
  cellNo: z.string().trim().max(50).nullable().optional(),
  contactNo: z.string().trim().max(50).nullable().optional(),
  website: z.string().trim().max(200).nullable().optional(),
  facebookUrl: z.string().trim().max(200).nullable().optional(),
  logoFileId: z.string().nullable().optional(),
});
export type ResortIdentityInput = z.infer<typeof resortIdentityInputSchema>;
