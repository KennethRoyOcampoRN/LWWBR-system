// Build plan stage 3 (spec.md §13 decision 13, 2026-11-04): key arrays
// and labels for the FolioCharge/Payment/Receipt enums, same
// REMITTANCE_STATUS_KEYS-style pattern as remittance.ts — mirrors the
// Prisma enums in schema.prisma exactly; keep both in sync by hand,
// same as every other enum pair in this codebase.

export const FOLIO_CHARGE_SOURCE_KEYS = ['ROOM', 'FNB', 'AMENITY', 'DEPOSIT', 'DAMAGE', 'PENALTY', 'MISC'] as const;
export type FolioChargeSourceKey = (typeof FOLIO_CHARGE_SOURCE_KEYS)[number];
export const FOLIO_CHARGE_SOURCE_LABELS: Record<FolioChargeSourceKey, string> = {
  ROOM: 'Room',
  FNB: 'Food & beverage',
  AMENITY: 'Amenity',
  DEPOSIT: 'Deposit',
  DAMAGE: 'Damage',
  PENALTY: 'Penalty',
  MISC: 'Other',
};

export const FOLIO_CHARGE_STATUS_KEYS = ['POSTED', 'VOIDED'] as const;
export type FolioChargeStatusKey = (typeof FOLIO_CHARGE_STATUS_KEYS)[number];

export const PAYMENT_METHOD_KEYS = ['GCASH', 'BANK', 'CASH', 'CARD', 'OTHER'] as const;
export type PaymentMethodKey = (typeof PAYMENT_METHOD_KEYS)[number];
export const PAYMENT_METHOD_LABELS: Record<PaymentMethodKey, string> = {
  GCASH: 'GCash',
  BANK: 'Bank transfer',
  CASH: 'Cash',
  CARD: 'Card',
  OTHER: 'Other',
};

export const PAYMENT_KIND_KEYS = ['DOWNPAYMENT', 'BALANCE', 'FULL', 'REFUND'] as const;
export type PaymentKindKey = (typeof PAYMENT_KIND_KEYS)[number];
export const PAYMENT_KIND_LABELS: Record<PaymentKindKey, string> = {
  DOWNPAYMENT: 'Downpayment',
  BALANCE: 'Balance',
  FULL: 'Full payment',
  REFUND: 'Refund',
};

export const PAYMENT_STATUS_KEYS = ['PENDING', 'VERIFIED', 'REJECTED'] as const;
export type PaymentStatusKey = (typeof PAYMENT_STATUS_KEYS)[number];
export const PAYMENT_STATUS_LABELS: Record<PaymentStatusKey, string> = {
  PENDING: 'Pending',
  VERIFIED: 'Verified',
  REJECTED: 'Rejected',
};

export const RECEIPT_STATUS_KEYS = ['ISSUED', 'VOIDED'] as const;
export type ReceiptStatusKey = (typeof RECEIPT_STATUS_KEYS)[number];
export const RECEIPT_STATUS_LABELS: Record<ReceiptStatusKey, string> = {
  ISSUED: 'Issued',
  VOIDED: 'Voided',
};

// Client decision, 2026-11-04 (the sample receipt's own "Deductions"
// block — see spec.md §13 decision 13 and Receipt's own schema.prisma
// comment): Downpayment, a discount (promo/senior/PWD), and a refund/
// correction are each their own row, not independent scalar fields.
// Senior and PWD get their own values rather than one generic DISCOUNT
// since both are PH statutory discounts (RA 9994, RA 10754) worth
// reporting separately later.
export const RECEIPT_DEDUCTION_TYPE_KEYS = [
  'DOWNPAYMENT',
  'DISCOUNT_PROMO',
  'DISCOUNT_SENIOR',
  'DISCOUNT_PWD',
  'REFUND_CORRECTION',
] as const;
export type ReceiptDeductionTypeKey = (typeof RECEIPT_DEDUCTION_TYPE_KEYS)[number];
export const RECEIPT_DEDUCTION_TYPE_LABELS: Record<ReceiptDeductionTypeKey, string> = {
  DOWNPAYMENT: 'Downpayment',
  DISCOUNT_PROMO: 'Discount (promo)',
  DISCOUNT_SENIOR: 'Discount (senior citizen)',
  DISCOUNT_PWD: 'Discount (PWD)',
  REFUND_CORRECTION: 'Refund / correction',
};
