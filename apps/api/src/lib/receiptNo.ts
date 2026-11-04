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

export function billingNumberScope(typedByCashier: string, now: Date = new Date()): string {
  return `${typedByCashier}-${manilaBillingDateStamp(now)}`;
}

export function formatBillingNumber(scope: string, seq: number): string {
  return `${scope}-${String(seq).padStart(2, '0')}`;
}
