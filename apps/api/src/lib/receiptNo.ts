import { TZDate } from '@date-fns/tz';
import { format } from 'date-fns';

// Build plan stage 3 (spec.md §13 decision 13, 2026-11-04): the billing
// number's own date component, {MMDDYYYY in Asia/Manila}. Same TZDate
// pattern as units/service.ts's todayStartInManila, bookings/service.ts's
// resolveArrivalDate, and reports/service.ts's resolveDate — NOT
// `new Date()`'s own getUTC*() components, which would roll the billing
// number over at 8am Manila time (UTC midnight) instead of local
// midnight, and NOT referenceNo.ts's generateReferenceNo(), whose
// `YYMMDD`-scoped, UTC-based format doesn't match this feature's own
// `{typedByCashier}-{MMDDYYYY}-{NN}` shape — this is a sibling to that
// function, not a caller of it.
const RESORT_TIMEZONE = 'Asia/Manila';

export function manilaBillingDateStamp(now: Date = new Date()): string {
  return format(new TZDate(now, RESORT_TIMEZONE), 'MMddyyyy');
}

// Spec.md §13 decision 28 (2026-11-15): scoped to the booking's own
// external reference ONLY — previously `${referenceNo}-${dateStamp}`,
// which reset the sequence every day and made three receipts issued on
// three different dates under the same booking all read "-01" (no way
// to tell them apart, and no way to tell their order from the number
// alone). The client's own requirement: "-01, -02, -03 for every new
// receipt issued under the same billing number," per booking across
// the whole stay, not per day. The date doesn't disappear — it's still
// in the formatted number below, as a stamp — it just no longer
// participates in what the sequence counts against.
export function billingNumberScope(referenceNo: string): string {
  return referenceNo;
}

export function formatBillingNumber(scope: string, seq: number, now: Date = new Date()): string {
  return `${scope}-${manilaBillingDateStamp(now)}-${String(seq).padStart(2, '0')}`;
}
