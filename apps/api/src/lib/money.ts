// Build plan stage 3 (spec.md §13 decision 13, 2026-11-04): money
// amounts are JS numbers end to end (same as every other Decimal field
// in this codebase — see stock/service.ts's own stockItemToJson
// comment), so every sum needs float-safe rounding to 2 decimal places
// rather than trusting raw floating-point addition (0.1 + 0.2 !== 0.3).
// Used by the receipts service to compute grandTotal/totalAmountDue
// from line/deduction amounts server-side — never trusting a client-
// submitted total, so a receipt can't be persisted with totals that
// don't reconcile with its own lines.
export function roundMoney(amount: number): number {
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

export function sumMoney(amounts: number[]): number {
  return roundMoney(amounts.reduce((total, amount) => total + amount, 0));
}
