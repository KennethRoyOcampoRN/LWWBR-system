import {
  FOLIO_CHARGE_SOURCE_KEYS,
  FOLIO_CHARGE_SOURCE_LABELS,
  isBookableUnitKind,
  PAYMENT_KIND_KEYS,
  PAYMENT_KIND_LABELS,
  PAYMENT_METHOD_KEYS,
  PAYMENT_METHOD_LABELS,
  RECEIPT_DEDUCTION_TYPE_KEYS,
  RECEIPT_DEDUCTION_TYPE_LABELS,
  type BookingStatusKey,
  type FolioChargeSourceKey,
  type PaymentKindKey,
  type PaymentMethodKey,
  type PaymentStatusKey,
  type ReceiptDeductionTypeKey,
} from '@lwwbr/shared';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button } from '../components/Button.js';
import { Card, Section } from '../components/Card.js';
import { DataTable, type DataTableColumn } from '../components/DataTable.js';
import { EmptyState } from '../components/EmptyState.js';
import { Field, INPUT_CLASSES } from '../components/Field.js';
import { PageHeader } from '../components/PageHeader.js';
import { StatusBadge } from '../components/StatusBadge.js';
import { CAPTION, NUMERIC_HERO } from '../components/typography.js';
import { useAuth } from '../context/AuthContext.js';
import { api, ApiRequestError } from '../lib/api.js';
import { BOOKING_STATUS_BADGE_VARIANT, BOOKING_STATUS_LABELS } from '../lib/bookingStyle.js';

interface DraftDeduction {
  type: ReceiptDeductionTypeKey;
  label: string;
  amount: number;
}

interface ComputedLine {
  description: string;
  qty: number;
  unitPrice: number;
  amount: number;
  // Spec.md §13 decision 25 (2026-11-14): which FolioCharge this line
  // came from — already returned by the API (gatherReceiptLines sets
  // it on every line), just not previously typed here. Lets a receipt
  // card cross-reference `folioCharges` to mark a line "Voided" if the
  // charge behind it has since been voided (only possible via Manage
  // Rooms' "Revert", which can void an already-receipted ROOM charge —
  // the charges-list Void action this used to also cover is gone).
  sourceChargeId: string | null;
}

interface ComputedDeduction extends DraftDeduction {
  amount: number;
  // Spec.md §13 decision 26 (2026-11-15): when this deduction is a
  // server-derived DOWNPAYMENT, when the payment behind it was taken
  // — undefined/null for a cashier-typed deduction, which has no
  // payment to date. "Payment received (Cash)" alone doesn't say when.
  // Optional (not just nullable) so the local draft array — which is
  // DraftDeduction, never actually a ComputedDeduction, and has no
  // server round-trip to supply this — still satisfies the type when
  // read by the same deductionColumns/DataTable the server-sourced
  // rows above also use.
  paymentSubmittedAt?: string | null;
}

// Spec.md §13 decision 26 (2026-11-15): unapplied payment credit —
// shown so the cashier can see it before any of it is drawn on, not
// after. Always present when credit exists, regardless of whether
// `applyAvailableCredit` actually drew on any of it this time.
interface AvailableCredit {
  paymentId: string;
  method: PaymentMethodKey;
  amount: number;
  submittedAt: string;
}

interface ResortHeader {
  name: string;
  address: string;
  cellNo: string | null;
  contactNo: string | null;
  website: string | null;
  facebookUrl: string | null;
  logo: { url: string } | null;
}

interface GuestBlock {
  name: string;
  address: string | null;
  contactNo: string | null;
  email: string | null;
}

interface PreviewResponse {
  resort: ResortHeader;
  guest: GuestBlock;
  lines: ComputedLine[];
  deductions: ComputedDeduction[];
  grandTotal: number;
  totalDeductions: number;
  totalAmountDue: number;
  // Spec.md §13 decision 18 (2026-11-06): the whole-account running
  // balance — a layout addition the client's own sample receipt
  // doesn't have.
  outstandingBalance: number;
  // Spec.md §13 decision 23 (2026-11-14): the cashier screen's totals
  // bridge (Charges, less payments, less discounts, equals Amount
  // due) — all four computed server-side, in `previewReceipt`, from
  // the exact same `computeFolioBalance` call that produces
  // `outstandingBalance`. The frontend used to re-derive these by
  // summing `folioCharges`/`payments`/`deductions` itself, which let
  // the bridge agree with the hero while both silently disagreed with
  // the server — the one figure that actually prints and persists.
  // There is now exactly one implementation of this arithmetic.
  chargesTotal: number;
  paymentsTotal: number;
  discountsTotal: number;
  amountDue: number;
  // Spec.md §13 decision 25 (2026-11-14): display-only — what a receipt
  // would be numbered if issued right now, computed server-side from
  // booking.referenceNo (peekNextBillingNumber). No cashier input
  // exists for this anymore; typing it was always transcribing a value
  // the system already held.
  billingNumberPreview: string;
  // Spec.md §13 decision 26 (2026-11-15): see AvailableCredit's own
  // comment.
  availableCredit: AvailableCredit[];
}

interface IssuedReceipt extends PreviewResponse {
  id: string;
  billingNumberFull: string;
  status: string;
  issuedAt: string;
  preparedByName: string;
}

interface BookingUnitRow {
  id: string;
  unitId: string;
  releasedAt: string | null;
  // Added 2026-11-06 (item 2's fix): presence/absence decides whether
  // this room still needs a cashier-supplied checkout date before it
  // can be priced — null only for a walk-up room never yet billed, or
  // one newly added via addUnitToBooking.
  occupiedTo: string | null;
  unit: { id: string; code: string; name: string; status: string; unitTypeName: string };
}

interface BookingDetail {
  id: string;
  referenceNo: string;
  guestName: string;
  status: BookingStatusKey;
  units: BookingUnitRow[];
}

// Spec.md §13 decision 17 (2026-11-06): one audit row per override event
// on a FolioCharge. The earliest row's previousAmount is the "original"
// shown in the UI; see overriddenBadge below.
interface FolioChargeOverrideRow {
  id: string;
  previousUnitPrice: number;
  previousAmount: number;
  newUnitPrice: number;
  newAmount: number;
  reason: string;
  overriddenAt: string;
}

interface FolioChargeRow {
  id: string;
  bookingId: string;
  source: FolioChargeSourceKey;
  // For ROOM, the BookingUnit id this charge was priced against — same
  // field postFolioChargeSchema's own sourceId already carries. Added
  // 2026-11-06 (client's 2nd round) so the Rooms section can tell
  // "already posted" from "not yet charged" per room, rather than
  // leaving double-posting to the cashier's own memory.
  sourceId: string | null;
  description: string;
  qty: number;
  unitPrice: number;
  amount: number;
  status: string;
  overrides: FolioChargeOverrideRow[];
  // Spec.md §13 decision 21 (2026-11-06): true once some non-voided
  // receipt already references this charge — the fact that decides
  // Delete (never receipted, no reason needed) vs. Void (receipted,
  // visible and reasoned) automatically, per the client's own "the
  // purpose of delete is for errors, don't make it hard to delete
  // errors."
  hasBeenReceipted: boolean;
}

interface UnsettledFnbCharge {
  fnbOrderId: string;
  referenceNo: string;
  bookingId: string;
  unit: { id: string; code: string; name: string };
  subtotal: number;
  createdAt: string;
}

// Spec.md §13 decision 19 (2026-11-06): what the Payments section
// lists. submittedBy is joined server-side for its fullName — the
// cashier sees who recorded it, not a raw user id.
interface PaymentRow {
  id: string;
  amount: number;
  method: PaymentMethodKey;
  kind: PaymentKindKey;
  referenceNo: string | null;
  status: PaymentStatusKey;
  submittedAt: string;
  submittedBy: { fullName: string };
}

interface ReadyUnit {
  id: string;
  code: string;
  name: string;
  type: string;
  status: string;
}

// Spec.md §13 decision 25 (2026-11-14): one fewer than decision 23 had
// — Print Receipt is gone as a toggle (issuing now lives directly in
// the "Current charges" panel, which *is* the next receipt) and Past
// Receipts is gone entirely (the right-hand receipts stack is always
// on screen, never behind a click). Still one key, not five booleans,
// for the same reason as before: opening one replaces the slot below
// the button bar rather than stacking.
type RightPanelKey = 'addCharge' | 'addDiscount' | 'manageRooms' | 'guestDetails' | 'paymentHistory';

// Non-ROOM sources only — a ROOM charge is always posted per-room, from
// the Rooms section's own "Post room charge" action, never from this
// generic form (postFolioChargeSchema itself rejects a client-submitted
// unitPrice/qty for ROOM — see billing/service.ts's own comment).
const NON_ROOM_SOURCE_KEYS = FOLIO_CHARGE_SOURCE_KEYS.filter((k) => k !== 'ROOM');

// Spec.md §13 decision 18 (2026-11-06): DOWNPAYMENT is now server-
// derived from recorded payments, not cashier-typed — the API rejects
// one with a 422 (receiptDeductionInputSchema), so it's dropped from
// this form's own type choices rather than left in to fail on submit.
const CASHIER_DEDUCTION_TYPE_KEYS = RECEIPT_DEDUCTION_TYPE_KEYS.filter((k) => k !== 'DOWNPAYMENT');

const EMPTY_CHARGE_FORM = { source: NON_ROOM_SOURCE_KEYS[0] as FolioChargeSourceKey, description: '', qty: '1', unitPrice: '' };
const EMPTY_DEDUCTION_FORM = { type: CASHIER_DEDUCTION_TYPE_KEYS[0] as ReceiptDeductionTypeKey, label: '', amount: '' };
const EMPTY_PAYMENT_FORM = { amount: '', method: 'CASH' as PaymentMethodKey, kind: 'DOWNPAYMENT' as PaymentKindKey, referenceNo: '' };

function formatPeso(amount: number): string {
  return `₱${amount.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Re-plan, spec.md §13 decision 16, Stage C (2026-11-05): rebuilt around
// the running folio rather than a client-typed receipt draft.
// `receiptDraftSchema`/`issueReceiptSchema` no longer accept a `lines`
// array at all — both `previewReceipt` and `issueReceipt` build it
// themselves from the booking's own posted `FolioCharge` rows (gathered
// across every sibling booking sharing the external ID). This page's
// own folio table is read-only for exactly that reason: the cashier
// posts charges (room, F&B pull-in, other), and the receipt preview
// reflects whatever's actually been posted, not a separate draft that
// could drift from it. Reached either from UnitsPage's own "Bill guest"
// link on a booking row, or from the Cashier nav item's own picker/
// new-pre-arrival-booking flow (CashierPage.tsx).
export function BillingPage() {
  const { bookingId } = useParams<{ bookingId: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [booking, setBooking] = useState<BookingDetail | 'loading' | 'error'>('loading');
  // Spec.md §13 decision 25 (2026-11-14): "current charges" means
  // exactly !hasBeenReceipted && status !== 'VOIDED'. Decision 27
  // (2026-11-15) removed per-charge void outright — a VOIDED status on
  // a FolioCharge is now historical only, never written by any live
  // path (Manage Rooms' "Revert" deletes a never-receipted charge the
  // same way the Charges list's own Delete action does; a receipted
  // one is corrected only by voiding its receipt).
  const [folioCharges, setFolioCharges] = useState<FolioChargeRow[]>([]);
  const [unsettledFnb, setUnsettledFnb] = useState<UnsettledFnbCharge[]>([]);
  const [readyUnits, setReadyUnits] = useState<ReadyUnit[]>([]);
  const [preview, setPreview] = useState<PreviewResponse | 'loading' | 'error'>('loading');
  const [deductions, setDeductions] = useState<DraftDeduction[]>([]);
  const [deductionForm, setDeductionForm] = useState(EMPTY_DEDUCTION_FORM);
  const [chargeForm, setChargeForm] = useState(EMPTY_CHARGE_FORM);
  const [postingCharge, setPostingCharge] = useState(false);
  const [chargeError, setChargeError] = useState<string | null>(null);
  // Spec.md §13 decision 17: cashier-editable amounts. Keyed by charge
  // id so only one row's override form is open at a time, same shape as
  // showReasonFor's own single-open-form pattern below.
  const [overridingChargeId, setOverridingChargeId] = useState<string | null>(null);
  const [overrideUnitPrice, setOverrideUnitPrice] = useState('');
  const [overrideReason, setOverrideReason] = useState('');
  const [overrideError, setOverrideError] = useState<string | null>(null);
  const [overriding, setOverriding] = useState(false);
  // Spec.md §13 decision 17: a draft deduction is edited in place behind
  // the same confirm-dialog-with-required-reason UX as a charge override,
  // for UI consistency only — no audit table backs this (see spec entry).
  const [editingDeductionIndex, setEditingDeductionIndex] = useState<number | null>(null);
  const [editDeductionLabel, setEditDeductionLabel] = useState('');
  const [editDeductionAmount, setEditDeductionAmount] = useState('');
  const [editDeductionReason, setEditDeductionReason] = useState('');
  // Spec.md §13 decision 19: the Payments section — record a payment,
  // list what's already recorded, and distinguish CASH (effective
  // immediately) from everything else (awaits payment:verify).
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [paymentForm, setPaymentForm] = useState(EMPTY_PAYMENT_FORM);
  const [postingPayment, setPostingPayment] = useState(false);
  const [paymentError, setPaymentError] = useState<string | null>(null);
  // Spec.md §13 decision 20: past receipts for this booking, and the
  // void action — same confirm-dialog-with-required-reason shape as
  // every other void/revert in this file.
  const [receipts, setReceipts] = useState<IssuedReceipt[]>([]);
  const [voidingReceiptId, setVoidingReceiptId] = useState<string | null>(null);
  const [receiptVoidReason, setReceiptVoidReason] = useState('');
  const [receiptVoidError, setReceiptVoidError] = useState<string | null>(null);
  const [voidingReceipt, setVoidingReceipt] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [resolveReason, setResolveReason] = useState('');
  const [showReasonFor, setShowReasonFor] = useState<'CANCELLED' | 'NO_SHOW' | null>(null);
  const [movingFromUnitId, setMovingFromUnitId] = useState<string | null>(null);
  const [moveToUnitId, setMoveToUnitId] = useState('');
  const [addUnitId, setAddUnitId] = useState('');
  const [roomActionError, setRoomActionError] = useState<string | null>(null);
  const [roomActionBusy, setRoomActionBusy] = useState(false);
  // Item 2's fix: a walk-up room (occupiedTo still null — never
  // priced) needs the cashier to supply a checkout date before it can
  // be charged. Keyed by BookingUnit id, one per room row.
  const [roomCheckOutDates, setRoomCheckOutDates] = useState<Record<string, string>>({});

  // Spec.md §13 decision 29 (2026-11-15): the rate plan picker. One
  // selection for the whole booking, not per room — "one plan applies
  // to the whole stay," confirmed explicitly — pre-selected once from
  // GET /bookings/:id/rate-plans's own suggestion (remembered/date-
  // match/standard-default) and left alone after that so a later
  // refetch never clobbers a cashier's own manual change. Rendered
  // prominently near the header's own "Amount due," per the client's
  // own words — "very noteworthy which is selected on the top" — not
  // tucked inside Manage rooms, which only consumes the selection.
  const [ratePlanOptions, setRatePlanOptions] = useState<{ id: string; name: string }[]>([]);
  const [selectedRatePlanId, setSelectedRatePlanId] = useState<string | null>(null);
  const [ratePlanLoadError, setRatePlanLoadError] = useState<string | null>(null);
  // Spec.md §13 decision 31 (2026-11-16): the Rooms-section rate-
  // visibility fix — rate/nights/amount for the currently selected
  // plan, per room, fetched from the same pricing function a real
  // charge uses (GET .../rate-plans/price), never computed client-side.
  const [roomPricePreviews, setRoomPricePreviews] = useState<
    Record<string, { status: 'loading' } | { status: 'error'; message: string } | { status: 'ok'; unitPrice: number; qty: number; amount: number }>
  >({});
  // Spec.md §13 decision 29: the client's own concern — a three-room
  // booking drifting across plans unnoticed. Set when postRoomCharge's
  // own POST 409s RATE_PLAN_MISMATCH; confirming retries the same call
  // with confirmRatePlanMismatch: true.
  const [pendingRatePlanMismatch, setPendingRatePlanMismatch] = useState<{ bookingUnitId: string; checkOutDate?: string; message: string } | null>(
    null,
  );

  // Spec.md §13 decision 25 (2026-11-14): no more billingNumberTyped —
  // the billing number is display-only now (previewData.
  // billingNumberPreview), never a cashier input. preparedByName still
  // is one, just pre-filled from the signed-in user rather than blank.
  const [preparedByName, setPreparedByName] = useState(user?.fullName ?? '');
  const [guestContactNo, setGuestContactNo] = useState('');
  const [guestEmail, setGuestEmail] = useState('');
  const [checkInDate, setCheckInDate] = useState('');
  const [checkOutDate, setCheckOutDate] = useState('');
  const [nightsOfStay, setNightsOfStay] = useState('');

  const [previewing, setPreviewing] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [issueError, setIssueError] = useState<string | null>(null);
  const [issuedReceipt, setIssuedReceipt] = useState<IssuedReceipt | null>(null);
  // Spec.md §13 decision 20: true only when issuedReceipt was loaded via
  // the Past Receipts table's "View" action, never when it's the result
  // of actually issuing one — see IssuedReceiptView's own comment.
  const [viewedPastReceipt, setViewedPastReceipt] = useState(false);

  // Spec.md §13 decision 23 (2026-11-14): the right column's single
  // open panel — see RightPanelKey's own comment. Take Payment is not
  // one of these; it renders unconditionally at the top of the right
  // column, since it's the main job, not an exception.
  const [rightPanel, setRightPanel] = useState<RightPanelKey | null>(null);

  // Spec.md §13 decision 26 (2026-11-15): the client's own finding —
  // a derived DOWNPAYMENT deduction applied with no cashier action and
  // no announcement is "alarming rather than convenient" at a counter
  // with a guest present. Defaults true (the exact pre-decision-26
  // behavior — cash effective on record, decision 18's own point,
  // still holds), but it's now a visible, reversible checkbox rather
  // than something that just happens. Toggling it re-runs the preview
  // so the draw/deduction actually appears or disappears live.
  const [applyAvailableCredit, setApplyAvailableCredit] = useState(true);

  function draftBody() {
    return {
      guestContactNo: guestContactNo.trim() || null,
      guestEmail: guestEmail.trim() || null,
      checkInDate: checkInDate ? new Date(checkInDate).toISOString() : null,
      checkOutDate: checkOutDate ? new Date(checkOutDate).toISOString() : null,
      nightsOfStay: nightsOfStay ? Number(nightsOfStay) : null,
      preparedByName: preparedByName.trim(),
      deductions,
      applyAvailableCredit,
    };
  }

  // Spec.md §13 decision 26 (2026-11-15): `overrides` lets the
  // "Apply available credit" checkbox's own onChange hand in the new
  // value directly — setApplyAvailableCredit's update isn't visible to
  // draftBody()'s closure until the next render, so without this the
  // very next preview call would still send the stale, pre-click value.
  function runPreview(overrides?: Partial<ReturnType<typeof draftBody>>) {
    if (!bookingId) return Promise.resolve();
    setPreviewing(true);
    setIssueError(null);
    return api
      .post<PreviewResponse>(`/bookings/${bookingId}/receipts/preview`, { ...draftBody(), ...overrides })
      .then((res) => {
        setPreview(res);
        if (!guestContactNo && res.guest.contactNo) setGuestContactNo(res.guest.contactNo);
        if (!guestEmail && res.guest.email) setGuestEmail(res.guest.email);
      })
      .catch((err) => {
        if (err instanceof ApiRequestError && err.code === 'DEDUCTIONS_EXCEED_GRAND_TOTAL') {
          setIssueError(err.message);
          return;
        }
        setPreview('error');
      })
      .finally(() => setPreviewing(false));
  }

  function refetchFolio() {
    if (!bookingId) return;
    api
      .get<{ folioCharges: FolioChargeRow[] }>(`/bookings/${bookingId}/folio-charges`)
      .then((res) => setFolioCharges(res.folioCharges))
      .catch(() => setFolioCharges([]));
    api
      .get<{ charges: UnsettledFnbCharge[] }>(`/bookings/${bookingId}/unsettled-fnb-charges`)
      .then((res) => setUnsettledFnb(res.charges))
      .catch(() => setUnsettledFnb([]));
  }

  // Spec.md §13 decision 19: refetched alongside the folio — a payment
  // recorded here is what moves the balance and surfaces as a derived
  // DOWNPAYMENT deduction, so the two always need to refresh together.
  function refetchPayments() {
    if (!bookingId) return;
    api
      .get<{ payments: PaymentRow[] }>(`/bookings/${bookingId}/payments`)
      .then((res) => setPayments(res.payments))
      .catch(() => setPayments([]));
  }

  // Spec.md §13 decision 20: refetched alongside the folio — voiding a
  // receipt releases its charges back to be re-billed (decision 18's
  // incremental exclusion), so the two always need to refresh together.
  function refetchReceipts() {
    if (!bookingId) return;
    api
      .get<{ receipts: IssuedReceipt[] }>(`/bookings/${bookingId}/receipts`)
      .then((res) => setReceipts(res.receipts))
      .catch(() => setReceipts([]));
  }

  function refetchBooking() {
    if (!bookingId) return;
    api
      .get<{ booking: BookingDetail }>(`/bookings/${bookingId}`)
      .then((res) => setBooking(res.booking))
      .catch(() => setBooking('error'));
  }

  useEffect(() => {
    refetchBooking();
    refetchFolio();
    refetchPayments();
    refetchReceipts();
    void runPreview();
    api
      .get<{ units: ReadyUnit[] }>('/units')
      .then((res) => setReadyUnits(res.units.filter((u) => u.status === 'READY' && isBookableUnitKind(u.type))))
      .catch(() => setReadyUnits([]));
    // Only on mount (keyed on bookingId) — every later recompute/refetch
    // is an explicit action (posting a charge, Update preview), not an
    // auto-refetch on every keystroke.
  }, [bookingId]);

  // Spec.md §13 decision 29 (2026-11-15): fetched once per booking, from
  // whichever active room happens to be first — the suggestion (and the
  // active-plan list itself) isn't room-specific in any way that
  // matters here, since one plan applies to the whole stay. Guarded by
  // a ref, not just `selectedRatePlanId !== null`, so a booking with no
  // plans at all yet (suggestedRatePlanId: null) doesn't keep refetching
  // on every booking refresh.
  const ratePlanOptionsFetchedOnce = useRef(false);
  useEffect(() => {
    if (!bookingId || booking === 'loading' || booking === 'error' || ratePlanOptionsFetchedOnce.current) return;
    const firstActiveUnit = booking.units.find((u) => !u.releasedAt);
    if (!firstActiveUnit) return;
    ratePlanOptionsFetchedOnce.current = true;
    const params = new URLSearchParams({ bookingUnitId: firstActiveUnit.id });
    api
      .get<{ ratePlans: { id: string; name: string }[]; suggestedRatePlanId: string | null }>(`/bookings/${bookingId}/rate-plans?${params}`)
      .then((res) => {
        setRatePlanOptions(res.ratePlans);
        if (res.suggestedRatePlanId) setSelectedRatePlanId(res.suggestedRatePlanId);
      })
      .catch((err) => setRatePlanLoadError(err instanceof ApiRequestError ? err.message : 'Could not load rate plans.'));
  }, [bookingId, booking]);

  // Spec.md §13 decision 31 (2026-11-16): the Rooms-section rate-
  // visibility fix — re-prices every not-yet-charged room whenever the
  // selected plan changes (or a walk-up room's checkout date is typed),
  // via the same pricing function a real charge uses.
  useEffect(() => {
    if (!bookingId || booking === 'loading' || booking === 'error' || !selectedRatePlanId) return;
    const activeUnitsForPricing = booking.units.filter((u) => !u.releasedAt);
    for (const bu of activeUnitsForPricing) {
      const alreadyCharged = folioCharges.some((c) => c.source === 'ROOM' && c.sourceId === bu.id && c.status !== 'VOIDED');
      if (alreadyCharged) continue;
      const checkOutDate = bu.occupiedTo ? undefined : roomCheckOutDates[bu.id];
      if (!bu.occupiedTo && !checkOutDate) continue; // nothing to price yet — the checkout-date field below still needs filling in
      setRoomPricePreviews((prev) => ({ ...prev, [bu.id]: { status: 'loading' } }));
      const params = new URLSearchParams({ bookingUnitId: bu.id, ratePlanId: selectedRatePlanId });
      if (checkOutDate) params.set('checkOutDate', checkOutDate);
      api
        .get<{ unitPrice: number; qty: number; amount: number }>(`/bookings/${bookingId}/rate-plans/price?${params}`)
        .then((res) => setRoomPricePreviews((prev) => ({ ...prev, [bu.id]: { status: 'ok', ...res } })))
        .catch((err) =>
          setRoomPricePreviews((prev) => ({
            ...prev,
            [bu.id]: { status: 'error', message: err instanceof ApiRequestError ? err.message : 'Could not price this room.' },
          })),
        );
    }
  }, [bookingId, booking, selectedRatePlanId, folioCharges, roomCheckOutDates]);

  async function handlePostCharge() {
    if (!bookingId) return;
    const qty = Number(chargeForm.qty);
    const unitPrice = Number(chargeForm.unitPrice);
    if (!chargeForm.description.trim() || !Number.isInteger(qty) || qty < 1 || !(unitPrice >= 0)) return;
    setPostingCharge(true);
    setChargeError(null);
    try {
      await api.post(`/bookings/${bookingId}/folio-charges`, {
        source: chargeForm.source,
        description: chargeForm.description.trim(),
        qty,
        unitPrice,
      });
      setChargeForm(EMPTY_CHARGE_FORM);
      refetchFolio();
      void runPreview();
    } catch (err) {
      setChargeError(err instanceof ApiRequestError ? err.message : 'Could not post this charge.');
    } finally {
      setPostingCharge(false);
    }
  }

  // Spec.md §13 decision 19 (2026-11-06): this is what makes decision
  // 18's entire backend half reachable — recording a payment here is
  // the only way the balance ever moves, a DOWNPAYMENT deduction is
  // ever derived, or Receipt.outstandingBalance is ever anything but
  // the full amount. void runPreview() afterward so a CASH payment's
  // effect on the balance/derived deduction shows immediately, exactly
  // the "effective on record" decision 18 itself describes — a non-
  // cash payment still shows up in the list below, just marked as
  // awaiting verification rather than moving anything yet.
  async function handleSubmitPayment() {
    if (!bookingId) return;
    const amount = Number(paymentForm.amount);
    if (!(amount > 0)) return;
    setPostingPayment(true);
    setPaymentError(null);
    try {
      await api.post(`/bookings/${bookingId}/payments`, {
        amount,
        method: paymentForm.method,
        kind: paymentForm.kind,
        referenceNo: paymentForm.referenceNo.trim() || undefined,
      });
      setPaymentForm(EMPTY_PAYMENT_FORM);
      refetchPayments();
      void runPreview();
    } catch (err) {
      setPaymentError(err instanceof ApiRequestError ? err.message : 'Could not record this payment.');
    } finally {
      setPostingPayment(false);
    }
  }

  // Spec.md §13 decision 25 (2026-11-14): cashier-level delete for a
  // misrecorded payment — same no-reason, plain-confirm shape as
  // handleDeleteCharge, and the same line drawn server-side: a 409 if
  // some issued receipt has already drawn on this payment (the error
  // message names the real fix, voiding that receipt, rather than the
  // UI silently allowing something that would desync an issued
  // document's own totals).
  async function handleDeletePayment(paymentId: string) {
    if (!window.confirm('Delete this payment record?')) return;
    setPaymentError(null);
    try {
      await api.delete(`/payments/${paymentId}`);
      refetchPayments();
      void runPreview();
    } catch (err) {
      setPaymentError(err instanceof ApiRequestError ? err.message : 'Could not delete this payment.');
    }
  }

  async function pullInFnbCharge(charge: UnsettledFnbCharge) {
    if (!bookingId) return;
    setChargeError(null);
    try {
      await api.post(`/bookings/${bookingId}/folio-charges`, {
        source: 'FNB',
        sourceId: charge.fnbOrderId,
        description: `F&B order ${charge.referenceNo} (${charge.unit.code})`,
        qty: 1,
        unitPrice: charge.subtotal,
      });
      refetchFolio();
      void runPreview();
    } catch (err) {
      setChargeError(err instanceof ApiRequestError ? err.message : 'Could not add this charge to the folio.');
    }
  }

  // Bug caught in review, 2026-11-06 (spec.md §13 decision 16): this
  // used to set chargeError, rendered down in the Folio section — but
  // this action's own trigger button lives in the Rooms section, which
  // renders roomActionError. A 422 from this call was being caught and
  // shown where the cashier wasn't looking, so the button looked dead.
  //
  // Spec.md §13 decision 29 (2026-11-15): description is no longer a
  // parameter here — the server builds it, naming the selected plan.
  // ratePlanId is the cashier's current picker selection; a
  // RATE_PLAN_MISMATCH 409 is caught here (not left to roomActionError)
  // specifically so it can offer a confirm, not just report a failure —
  // confirmed is set true only on the retry after the cashier accepts
  // the warning dialog below.
  async function postRoomCharge(bookingUnitId: string, checkOutDate?: string, confirmed = false) {
    if (!bookingId || !selectedRatePlanId) return;
    setRoomActionError(null);
    try {
      await api.post(`/bookings/${bookingId}/folio-charges`, {
        source: 'ROOM',
        sourceId: bookingUnitId,
        ratePlanId: selectedRatePlanId,
        checkOutDate,
        confirmRatePlanMismatch: confirmed,
      });
      setPendingRatePlanMismatch(null);
      refetchFolio();
      void runPreview();
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'RATE_PLAN_MISMATCH') {
        setPendingRatePlanMismatch({ bookingUnitId, checkOutDate, message: err.message });
        return;
      }
      setRoomActionError(err instanceof ApiRequestError ? err.message : 'Could not post the room charge.');
    }
  }

  // Spec.md §13 decision 27 (2026-11-15): the undo for a double-posted
  // room charge — "Post room charge" becomes a toggle (postedCharge
  // below decides which face renders), and this is its revert side.
  // Per-charge void is gone; a never-receipted room charge is deleted
  // outright (no trace, no reason), the same as any other charge. The
  // JSX below never calls this once the charge is already receipted —
  // that case has no button at all, only a note pointing at voiding
  // the receipt instead.
  async function revertRoomCharge(chargeId: string) {
    if (!window.confirm('Remove this room charge from the folio?')) return;
    setRoomActionError(null);
    try {
      await api.delete(`/folio-charges/${chargeId}`);
      refetchFolio();
      void runPreview();
    } catch (err) {
      setRoomActionError(err instanceof ApiRequestError ? err.message : 'Could not revert this room charge.');
    }
  }

  async function handleResolve(toStatus: 'CHECKED_IN' | 'CANCELLED' | 'NO_SHOW') {
    if (!bookingId) return;
    if ((toStatus === 'CANCELLED' || toStatus === 'NO_SHOW') && showReasonFor !== toStatus) {
      setShowReasonFor(toStatus);
      return;
    }
    setResolving(true);
    try {
      await api.post(`/bookings/${bookingId}/resolve`, { toStatus, reason: resolveReason.trim() || undefined });
      setShowReasonFor(null);
      setResolveReason('');
      refetchBooking();
    } catch (err) {
      setRoomActionError(err instanceof ApiRequestError ? err.message : 'Could not resolve this booking.');
    } finally {
      setResolving(false);
    }
  }

  async function handleMoveUnit(fromUnitId: string) {
    if (!bookingId || !moveToUnitId) return;
    setRoomActionBusy(true);
    setRoomActionError(null);
    try {
      await api.post(`/bookings/${bookingId}/move-unit`, { fromUnitId, toUnitId: moveToUnitId });
      setMovingFromUnitId(null);
      setMoveToUnitId('');
      refetchBooking();
    } catch (err) {
      setRoomActionError(err instanceof ApiRequestError ? err.message : 'Could not move this room.');
    } finally {
      setRoomActionBusy(false);
    }
  }

  async function handleAddUnit() {
    if (!bookingId || !addUnitId) return;
    setRoomActionBusy(true);
    setRoomActionError(null);
    try {
      await api.post(`/bookings/${bookingId}/add-unit`, { unitId: addUnitId });
      setAddUnitId('');
      refetchBooking();
    } catch (err) {
      setRoomActionError(err instanceof ApiRequestError ? err.message : 'Could not add this room.');
    } finally {
      setRoomActionBusy(false);
    }
  }

  function commitDeduction() {
    const amount = Number(deductionForm.amount);
    if (!deductionForm.label.trim() || !(amount > 0)) return;
    setDeductions((ds) => [...ds, { type: deductionForm.type, label: deductionForm.label.trim(), amount }]);
    setDeductionForm(EMPTY_DEDUCTION_FORM);
  }

  function removeDeduction(index: number) {
    setDeductions((ds) => ds.filter((_, i) => i !== index));
  }

  function startEditDeduction(index: number) {
    const d = deductions[index];
    if (!d) return;
    setEditingDeductionIndex(index);
    setEditDeductionLabel(d.label);
    setEditDeductionAmount(String(d.amount));
    setEditDeductionReason('');
  }

  function cancelEditDeduction() {
    setEditingDeductionIndex(null);
  }

  function commitEditDeduction() {
    if (editingDeductionIndex === null) return;
    const amount = Number(editDeductionAmount);
    if (!editDeductionLabel.trim() || !(amount > 0) || !editDeductionReason.trim()) return;
    setDeductions((ds) =>
      ds.map((d, i) => (i === editingDeductionIndex ? { ...d, label: editDeductionLabel.trim(), amount } : d)),
    );
    setEditingDeductionIndex(null);
  }

  function startOverride(charge: FolioChargeRow) {
    setOverridingChargeId(charge.id);
    setOverrideUnitPrice(String(charge.unitPrice));
    setOverrideReason('');
    setOverrideError(null);
  }

  function cancelOverride() {
    setOverridingChargeId(null);
    setOverrideError(null);
  }

  async function handleOverride() {
    if (!overridingChargeId) return;
    const newUnitPrice = Number(overrideUnitPrice);
    if (!(newUnitPrice >= 0) || !overrideReason.trim()) return;
    setOverriding(true);
    setOverrideError(null);
    try {
      await api.post(`/folio-charges/${overridingChargeId}/override`, {
        newUnitPrice,
        reason: overrideReason.trim(),
      });
      setOverridingChargeId(null);
      refetchFolio();
      void runPreview();
    } catch (err) {
      setOverrideError(err instanceof ApiRequestError ? err.message : 'Could not override this charge.');
    } finally {
      setOverriding(false);
    }
  }

  // Spec.md §13 decision 21: the lower-friction sibling of void, for a
  // charge no receipt has ever referenced — no reason prompt, since
  // the client's own point was that an error corrected seconds later
  // shouldn't demand an explanation. A plain confirm is still worth
  // keeping (this has no undo in the UI, even though the audit
  // extension still records the delete) — just not a form.
  async function handleDeleteCharge(chargeId: string) {
    if (!window.confirm('Delete this charge from the folio?')) return;
    setChargeError(null);
    try {
      await api.delete(`/folio-charges/${chargeId}`);
      refetchFolio();
      void runPreview();
    } catch (err) {
      setChargeError(err instanceof ApiRequestError ? err.message : 'Could not delete this charge.');
    }
  }

  // Spec.md §13 decision 20: GET /receipts/:id — reuses the exact
  // issuedReceipt state/early-return the just-issued view already uses,
  // "Start another receipt" doubling as "back to billing" either way.
  async function viewReceipt(id: string) {
    setReceiptVoidError(null);
    try {
      const res = await api.get<{ receipt: IssuedReceipt }>(`/receipts/${id}`);
      setIssuedReceipt(res.receipt);
      setViewedPastReceipt(true);
    } catch (err) {
      setReceiptVoidError(err instanceof ApiRequestError ? err.message : 'Could not load this receipt.');
    }
  }

  // Spec.md §13 decision 20: voiding a receipt releases its charges
  // back to the folio for re-billing (decision 18's incremental
  // exclusion reads straight off a non-voided ReceiptLine, so nothing
  // special-case is needed here beyond refetching both lists).
  async function handleVoidReceipt() {
    if (!voidingReceiptId || !receiptVoidReason.trim()) return;
    setVoidingReceipt(true);
    setReceiptVoidError(null);
    try {
      await api.post(`/receipts/${voidingReceiptId}/void`, { voidReason: receiptVoidReason.trim() });
      setVoidingReceiptId(null);
      refetchReceipts();
      refetchFolio();
      void runPreview();
    } catch (err) {
      setReceiptVoidError(err instanceof ApiRequestError ? err.message : 'Could not void this receipt.');
    } finally {
      setVoidingReceipt(false);
    }
  }

  async function handleIssue(confirmDuplicateBillingNumber = false) {
    if (!bookingId) return;
    setIssueError(null);
    setIssuing(true);
    try {
      const receipt = await api.post<{ receipt: IssuedReceipt }>(`/bookings/${bookingId}/receipts`, {
        ...draftBody(),
        confirmDuplicateBillingNumber,
      });
      setIssuedReceipt(receipt.receipt);
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'DUPLICATE_BILLING_NUMBER') {
        const proceed = window.confirm(`${err.message}\n\nClick OK to issue it anyway.`);
        if (proceed) {
          setIssuing(false);
          await handleIssue(true);
          return;
        }
        setIssueError(null);
      } else {
        setIssueError(err instanceof ApiRequestError ? err.message : 'Could not issue the receipt.');
      }
    } finally {
      setIssuing(false);
    }
  }

  function startAnotherReceipt() {
    setIssuedReceipt(null);
    setViewedPastReceipt(false);
    setDeductions([]);
    refetchFolio();
    refetchReceipts();
    void runPreview();
  }

  // Spec.md §13 decision 25 (2026-11-14): "Current charges" never
  // shows a receipted or voided row (see folioCharges's own state
  // comment above), so there's nothing left to pick between — every
  // row here only ever offers Override and Delete.
  function folioRowActions(l: FolioChargeRow) {
    return (
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" onClick={() => startOverride(l)}>
          Override amount
        </Button>
        <Button type="button" variant="secondary" onClick={() => void handleDeleteCharge(l.id)}>
          Delete
        </Button>
      </div>
    );
  }

  const folioColumns: DataTableColumn<FolioChargeRow>[] = [
    {
      key: 'description',
      header: 'Items',
      render: (l) => (
        <>
          {l.description}
          {/* Spec.md §13 decision 17: the earliest override row's
              previousAmount is "original" — a line with no override
              rows was never touched, so no badge renders. */}
          {(l.overrides ?? []).length > 0 && (
            <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
              Overridden (was {formatPeso(l.overrides[0]!.previousAmount)})
            </span>
          )}
        </>
      ),
    },
    { key: 'source', header: 'Source', render: (l) => FOLIO_CHARGE_SOURCE_LABELS[l.source] },
    { key: 'unitPrice', header: 'Price', render: (l) => formatPeso(l.unitPrice) },
    { key: 'qty', header: 'Quantity/Days', render: (l) => l.qty },
    { key: 'amount', header: 'Total', render: (l) => formatPeso(l.amount) },
    {
      key: 'actions',
      header: 'Actions',
      render: folioRowActions,
      hideOnMobile: true,
    },
  ];

  // Spec.md §13 decision 25 (2026-11-14): the Status column is gone —
  // "Balance effect" already carries the half of it that matters (did
  // this payment move the balance), and a Delete action replaces it,
  // gated the same way submitting one is (payment:submit).
  const paymentColumns: DataTableColumn<PaymentRow>[] = [
    { key: 'method', header: 'Method', render: (p) => PAYMENT_METHOD_LABELS[p.method] },
    { key: 'amount', header: 'Amount', render: (p) => formatPeso(p.amount) },
    { key: 'kind', header: 'Kind', render: (p) => PAYMENT_KIND_LABELS[p.kind] },
    { key: 'submittedAt', header: 'When', render: (p) => new Date(p.submittedAt).toLocaleString('en-PH', { timeZone: 'Asia/Manila' }) },
    { key: 'submittedBy', header: 'Recorded by', render: (p) => p.submittedBy.fullName },
    {
      key: 'effect',
      header: 'Balance effect',
      render: (p) =>
        p.method === 'CASH' ? (
          <span className="font-medium text-success-600">Effective immediately (cash)</span>
        ) : p.status === 'VERIFIED' ? (
          <span className="font-medium text-success-600">Effective (verified)</span>
        ) : p.status === 'REJECTED' ? (
          <span className="text-danger-600">Rejected — no effect</span>
        ) : (
          <span className="text-amber-700">Awaiting verification — not yet applied</span>
        ),
    },
    {
      key: 'actions',
      header: 'Actions',
      render: (p) =>
        Boolean(user?.permissions['payment:submit']) && (
          <Button variant="secondary" onClick={() => void handleDeletePayment(p.id)}>
            Delete
          </Button>
        ),
      hideOnMobile: true,
    },
  ];

  const deductionColumns: DataTableColumn<ComputedDeduction & { index: number }>[] = [
    { key: 'label', header: 'Deduction', render: (d) => d.label },
    { key: 'type', header: 'Type', render: (d) => RECEIPT_DEDUCTION_TYPE_LABELS[d.type] },
    { key: 'amount', header: 'Amount', render: (d) => `-${formatPeso(d.amount)}` },
    {
      key: 'actions',
      header: 'Actions',
      render: (d) => (
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => startEditDeduction(d.index)}>
            Edit
          </Button>
          <Button variant="secondary" onClick={() => removeDeduction(d.index)}>
            Remove
          </Button>
        </div>
      ),
      hideOnMobile: true,
    },
  ];

  if (issuedReceipt) {
    return <IssuedReceiptView receipt={issuedReceipt} onStartAnother={startAnotherReceipt} viewedPast={viewedPastReceipt} />;
  }

  const activeUnits = booking !== 'loading' && booking !== 'error' ? booking.units.filter((u) => !u.releasedAt) : [];
  // Spec.md §13 decision 19: the Payments section's own outstanding-
  // balance readout and the Deductions section's automatic-downpayment
  // readout both need the loaded preview, same narrowing idiom as
  // activeUnits above rather than re-narrowing `preview` inline at each
  // JSX site.
  const previewData = preview !== 'loading' && preview !== 'error' ? preview : null;
  // Spec.md §13 decision 25 (2026-11-14): "Current charges" — never a
  // receipted or voided row (see folioCharges's own state comment).
  const activeCharges = folioCharges.filter((c) => c.status !== 'VOIDED' && !c.hasBeenReceipted);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Bill guest"
        description="Builds an Acknowledgement Receipt from this booking's running folio."
        actions={
          <Button type="button" variant="secondary" onClick={() => navigate('/cashier')}>
            Back to Cashier
          </Button>
        }
      />

      {/* Re-plan, spec.md §13 decision 16: resolving a CONFIRMED
          (pre-arrival) booking — the guest actually arrives, or
          doesn't. Manual only, no automatic no-show timer. Kept as its
          own card, separate from the hero below, since it's a gate on
          the booking rather than a step in billing a guest who's
          already checked in. */}
      {booking !== 'loading' && booking !== 'error' && booking.status === 'CONFIRMED' && (
        <Card>
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium text-ink">Resolve this pre-arrival booking</p>
            {roomActionError && (
              <p role="alert" className="text-sm font-medium text-danger-600">
                {roomActionError}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={() => void handleResolve('CHECKED_IN')} disabled={resolving}>
                Guest checked in
              </Button>
              <Button type="button" variant="secondary" onClick={() => void handleResolve('CANCELLED')} disabled={resolving}>
                Cancel booking
              </Button>
              <Button type="button" variant="secondary" onClick={() => void handleResolve('NO_SHOW')} disabled={resolving}>
                Mark no-show
              </Button>
            </div>
            {showReasonFor && (
              <div className="flex flex-wrap items-end gap-3">
                <Field label={`Reason (optional) for ${showReasonFor === 'CANCELLED' ? 'cancelling' : 'marking no-show'}`}>
                  <input className={INPUT_CLASSES} value={resolveReason} onChange={(e) => setResolveReason(e.target.value)} />
                </Field>
                <Button type="button" onClick={() => void handleResolve(showReasonFor)} disabled={resolving}>
                  {resolving ? 'Confirming…' : 'Confirm'}
                </Button>
                <Button type="button" variant="secondary" onClick={() => setShowReasonFor(null)}>
                  Cancel
                </Button>
              </div>
            )}
          </div>
        </Card>
      )}

      {preview === 'loading' && <p className="text-sm text-ink-secondary">Loading…</p>}
      {preview === 'error' && <p role="alert">Could not load this booking.</p>}

      {/* Spec.md §13 decision 25 (2026-11-14): third redesign pass,
          replacing decision 23's "Charges list + bridge, left; Take
          Payment + toggles, right" split with the model the client
          drew directly. The old split put a receipted charge in the
          same list as an unpaid one (distinguished only by a
          "Receipted" badge) and a toggled "Print Receipt" panel beside
          a "Charges" list that was really a mix of settled and
          unsettled money — two things that read as one, needing a
          badge to tell apart. Here they're structurally separate: a
          charge leaves "Current charges" the moment it's receipted,
          appearing instead on its own receipt's card in the always-
          visible stack to the right — nothing to badge, because
          nothing is ambiguous.
          Three regions: (1) this top row — guest/rooms/booking and
          the whole-account Amount due (outstandingBalance, decisions
          23/24 — kept, not retired: the client's own sample receipt
          is issued *with* a balance outstanding, so the account-wide
          number has to keep meaning something even after a receipt
          exists) with its own totals bridge beneath it, beside Take
          Payment, unconditional, never a toggle. (2) the button bar,
          full width, holding what's left: Add charge/Add discount/
          Manage rooms/Guest details/Payment history — Print Receipt
          and Past Receipts aren't here, because issuing now lives
          directly in "Current charges" below (it *is* the next
          receipt) and past receipts are never behind a click.
          (3) the two working columns: "Current charges" (left, wider)
          — only charges not yet receipted, headed so that's explicit,
          with its own total scoped to just this draft receipt and the
          billing number it would issue as, displayed, never typed
          (clarifying, not reversing, decision 16 — the client's own
          words: the typed number was always required to equal
          booking.referenceNo, so there was nothing left to transcribe)
          — and the receipts stack (right, narrower), newest first,
          always visible, each card self-contained. */}
      {preview !== 'loading' && preview !== 'error' && booking !== 'loading' && booking !== 'error' && (
        <>
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_380px]">
            <Card>
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-lg font-semibold text-ink">{booking.guestName}</p>
                    <p className="text-sm text-ink-secondary">
                      {activeUnits.length > 0 ? activeUnits.map((u) => u.unit.code).join(', ') : 'No rooms held'} · Booking{' '}
                      {booking.referenceNo}
                    </p>
                  </div>
                  <StatusBadge variant={BOOKING_STATUS_BADGE_VARIANT[booking.status]}>
                    {BOOKING_STATUS_LABELS[booking.status]}
                  </StatusBadge>
                </div>
                {/* Spec.md §13 decision 29 (2026-11-15): the client's own
                    words — "very noteworthy which is selected on the
                    top" — this is the single biggest determinant of
                    what the guest pays, so it sits beside "Amount due,"
                    not tucked inside Manage rooms (which only ever
                    consumes this same selection). One plan for the
                    whole booking, not per room. */}
                {ratePlanOptions.length > 0 && (
                  <div className="flex flex-col gap-1 rounded-lg border-2 border-brand-300 bg-brand-50 p-3">
                    <label htmlFor="rate-plan-select" className="text-xs font-semibold uppercase tracking-wide text-brand-700">
                      Rate plan
                    </label>
                    <select
                      id="rate-plan-select"
                      className={INPUT_CLASSES}
                      value={selectedRatePlanId ?? ''}
                      onChange={(e) => setSelectedRatePlanId(e.target.value || null)}
                    >
                      {ratePlanOptions.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                {ratePlanLoadError && (
                  <p role="alert" className="text-sm font-medium text-danger-600">
                    {ratePlanLoadError}
                  </p>
                )}
                <div>
                  <p className={`${CAPTION} font-medium uppercase tracking-wide`}>Amount due</p>
                  {/* Visual redesign round 2 (spec.md §13 decision 40):
                      the one hero figure on this page — NUMERIC_HERO,
                      not a hand-typed text-4xl, so a future page can't
                      invent a third number size the way this one and
                      Command Center's KPI tiles already had before
                      this round. */}
                  <p className={NUMERIC_HERO}>{formatPeso(preview.outstandingBalance)}</p>
                </div>
                {/* Spec.md §13 decisions 23/24: the whole-account
                    bridge — reads the exact same server-computed
                    fields the headline above reads, so this box's own
                    numbers can never drift from each other. This is a
                    different, wider total than "Current charges" own
                    totals below: this one covers every charge ever
                    posted (receipted or not); that one covers only
                    what the next receipt would bill. */}
                <div className="flex flex-col gap-1 rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm">
                  <div className="flex justify-between">
                    <span>Charges</span>
                    <span className="font-mono tabular-nums">{formatPeso(preview.chargesTotal)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Less payments</span>
                    <span className="font-mono tabular-nums">-{formatPeso(preview.paymentsTotal)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Less discounts</span>
                    <span className="font-mono tabular-nums">-{formatPeso(preview.discountsTotal)}</span>
                  </div>
                  <div className="flex justify-between border-t border-gray-300 pt-1 text-base font-semibold text-ink">
                    <span>Amount due</span>
                    <span className="font-mono tabular-nums">{formatPeso(preview.amountDue)}</span>
                  </div>
                </div>
              </div>
            </Card>

            {/* Spec.md §13 decision 23: Take Payment is not a toggle —
                it's the main job, always beside the amount it's read
                against. */}
            <Section title="Take Payment">
              {paymentError && (
                <p role="alert" className="text-sm font-medium text-danger-600">
                  {paymentError}
                </p>
              )}
              <form
                className="flex flex-col gap-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void handleSubmitPayment();
                }}
              >
                <Field label="Amount">
                  <input
                    type="number"
                    min="0.01"
                    step="0.01"
                    className={INPUT_CLASSES}
                    value={paymentForm.amount}
                    onChange={(e) => setPaymentForm((f) => ({ ...f, amount: e.target.value }))}
                  />
                </Field>
                <Field label="Method">
                  <select
                    className={INPUT_CLASSES}
                    value={paymentForm.method}
                    onChange={(e) => setPaymentForm((f) => ({ ...f, method: e.target.value as PaymentMethodKey }))}
                  >
                    {PAYMENT_METHOD_KEYS.map((key) => (
                      <option key={key} value={key}>
                        {PAYMENT_METHOD_LABELS[key]}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Kind">
                  <select
                    className={INPUT_CLASSES}
                    value={paymentForm.kind}
                    onChange={(e) => setPaymentForm((f) => ({ ...f, kind: e.target.value as PaymentKindKey }))}
                  >
                    {PAYMENT_KIND_KEYS.map((key) => (
                      <option key={key} value={key}>
                        {PAYMENT_KIND_LABELS[key]}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Reference No. (optional)">
                  <input
                    className={INPUT_CLASSES}
                    value={paymentForm.referenceNo}
                    onChange={(e) => setPaymentForm((f) => ({ ...f, referenceNo: e.target.value }))}
                  />
                </Field>
                <Button type="submit" disabled={postingPayment}>
                  {postingPayment ? 'Recording…' : 'Record payment'}
                </Button>
              </form>
            </Section>
          </div>

          {/* Spec.md §13 decision 25: the button bar — full width,
              separating the header from the working area below. Print
              Receipt and Past Receipts aren't buttons anymore (see the
              region comment above); Take Payment isn't either, since
              it already has its own permanent box up top.
              Spec.md §13 decision 26: a 5-column grid stretched each
              button across its own equal-width cell, so a short label
              like "Add charge" sat left-aligned against a lot of empty
              cell — reading as "four buttons, then Payment history
              alone far to the right" rather than one grouped row. A
              flex row lets buttons hug their own content and each
              other instead. */}
          <div className="flex flex-wrap gap-3">
            <Button type="button" variant="secondary" onClick={() => setRightPanel((v) => (v === 'addCharge' ? null : 'addCharge'))}>
              Add charge
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setRightPanel((v) => (v === 'addDiscount' ? null : 'addDiscount'))}
            >
              Add discount
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setRightPanel((v) => (v === 'manageRooms' ? null : 'manageRooms'))}
            >
              Manage rooms
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setRightPanel((v) => (v === 'guestDetails' ? null : 'guestDetails'))}
            >
              Guest details
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setRightPanel((v) => (v === 'paymentHistory' ? null : 'paymentHistory'))}
            >
              Payment history
            </Button>
          </div>

            {/* Spec.md §13 decision 22: the charge-posting form and the
                F&B pull-in — occasional actions, not steps in the main
                flow. */}
            {rightPanel === 'addCharge' && (
              <Section title="Add charge">
                <div className="flex flex-col gap-3">
                  <Field label="Source">
                    <select
                      className={INPUT_CLASSES}
                      value={chargeForm.source}
                      onChange={(e) => setChargeForm((f) => ({ ...f, source: e.target.value as FolioChargeSourceKey }))}
                    >
                      {NON_ROOM_SOURCE_KEYS.map((key) => (
                        <option key={key} value={key}>
                          {FOLIO_CHARGE_SOURCE_LABELS[key]}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Description">
                    <input
                      className={INPUT_CLASSES}
                      value={chargeForm.description}
                      onChange={(e) => setChargeForm((f) => ({ ...f, description: e.target.value }))}
                    />
                  </Field>
                  <Field label="Quantity/Days">
                    <input
                      type="number"
                      min="1"
                      className={INPUT_CLASSES}
                      value={chargeForm.qty}
                      onChange={(e) => setChargeForm((f) => ({ ...f, qty: e.target.value }))}
                    />
                  </Field>
                  <Field label="Price">
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      className={INPUT_CLASSES}
                      value={chargeForm.unitPrice}
                      onChange={(e) => setChargeForm((f) => ({ ...f, unitPrice: e.target.value }))}
                    />
                  </Field>
                  <Button type="button" onClick={() => void handlePostCharge()} disabled={postingCharge}>
                    {postingCharge ? 'Posting…' : 'Post charge'}
                  </Button>
                </div>
                {/* Cashier-tab plan, Stage B (2026-11-05): the F&B
                    pull-in — unsettled charge-to-room orders across
                    every sibling booking, one click each to post to
                    the folio. */}
                <div>
                  <p className="mb-2 text-sm font-medium text-ink">Restaurant charges not yet on the folio</p>
                  {unsettledFnb.length === 0 && <EmptyState message="Nothing unsettled." />}
                  <ul className="flex flex-col gap-2">
                    {unsettledFnb.map((c) => (
                      <li
                        key={c.fnbOrderId}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-gray-200 p-3 text-sm"
                      >
                        <span>
                          {c.unit.code} — Order {c.referenceNo} — {formatPeso(c.subtotal)}
                        </span>
                        <Button type="button" variant="secondary" onClick={() => void pullInFnbCharge(c)}>
                          Add to folio
                        </Button>
                      </li>
                    ))}
                  </ul>
                </div>
                {chargeError && (
                  <p role="alert" className="text-sm font-medium text-danger-600">
                    {chargeError}
                  </p>
                )}
              </Section>
            )}

            {/* Spec.md §13 decision 22: Deductions folds into "Add
                discount" — cashier-typed deductions are an exception to
                the main flow, not a step in it. */}
            {rightPanel === 'addDiscount' && (
              <Section title="Add discount">
                <DataTable
                  columns={deductionColumns}
                  rows={deductions.map((d, index) => ({ ...d, index }))}
                  rowKey={(d) => String(d.index)}
                  emptyMessage="No deductions."
                  renderMobileActions={(d) => (
                    <>
                      <Button variant="secondary" onClick={() => startEditDeduction(d.index)}>
                        Edit
                      </Button>
                      <Button variant="secondary" onClick={() => removeDeduction(d.index)}>
                        Remove
                      </Button>
                    </>
                  )}
                />
                {/* Spec.md §13 decision 19 (2026-11-06): client's own catch
                    — decision 18 made DOWNPAYMENT server-derived and
                    dropped it from the dropdown above (correctly), but a
                    derived deduction still needs to be visible somewhere,
                    or a cashier who can't see a recorded payment's effect
                    will try to type one and hit the 422 cold. Read off
                    preview.deductions (the same server computation that
                    prices the receipt), not the local draft array — this
                    is never something commitDeduction/removeDeduction can
                    touch. */}
                {previewData && previewData.deductions.some((d) => d.type === 'DOWNPAYMENT') && (
                  <ul className="flex flex-col gap-1 rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm">
                    {previewData.deductions
                      .filter((d) => d.type === 'DOWNPAYMENT')
                      .map((d, i) => (
                        <li key={i} className="flex items-center justify-between gap-2">
                          <span>
                            {d.label}
                            {/* Spec.md §13 decision 26: the date the
                                payment behind this was actually taken
                                — the label alone doesn't say when. */}
                            {d.paymentSubmittedAt && (
                              <span className="ml-2 text-ink-secondary">
                                ({new Date(d.paymentSubmittedAt).toLocaleDateString('en-PH', { timeZone: 'Asia/Manila' })})
                              </span>
                            )}
                            <span className="ml-2 rounded-full bg-gray-200 px-2 py-0.5 text-xs font-medium text-ink-secondary">
                              Automatic — from a recorded payment, not editable
                            </span>
                          </span>
                          <span>-{formatPeso(d.amount)}</span>
                        </li>
                      ))}
                  </ul>
                )}
                {/* Spec.md §13 decision 17: in-place editing of a draft
                    deduction behind the same confirm-dialog-with-required-
                    reason UX as a charge override, for UI consistency only
                    — no FolioChargeOverride-style audit table backs this,
                    since a deduction was always cashier-typed with no
                    system-computed baseline to deviate from. */}
                {editingDeductionIndex !== null && (
                  <div className="flex flex-col gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3">
                    <div className="flex flex-col gap-3">
                      <Field label="Label">
                        <input className={INPUT_CLASSES} value={editDeductionLabel} onChange={(e) => setEditDeductionLabel(e.target.value)} />
                      </Field>
                      <Field label="Amount">
                        <input
                          type="number"
                          min="0.01"
                          step="0.01"
                          className={INPUT_CLASSES}
                          value={editDeductionAmount}
                          onChange={(e) => setEditDeductionAmount(e.target.value)}
                        />
                      </Field>
                      <Field label="Reason" hint="Required.">
                        <input
                          className={INPUT_CLASSES}
                          value={editDeductionReason}
                          onChange={(e) => setEditDeductionReason(e.target.value)}
                        />
                      </Field>
                      <div className="flex items-end gap-2">
                        <Button type="button" onClick={commitEditDeduction}>
                          Save
                        </Button>
                        <Button type="button" variant="secondary" onClick={cancelEditDeduction}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
                <div className="flex flex-col gap-3">
                  <Field label="Type">
                    <select
                      className={INPUT_CLASSES}
                      value={deductionForm.type}
                      onChange={(e) =>
                        setDeductionForm((f) => ({ ...f, type: e.target.value as ReceiptDeductionTypeKey }))
                      }
                    >
                      {CASHIER_DEDUCTION_TYPE_KEYS.map((key) => (
                        <option key={key} value={key}>
                          {RECEIPT_DEDUCTION_TYPE_LABELS[key]}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Label">
                    <input
                      className={INPUT_CLASSES}
                      value={deductionForm.label}
                      onChange={(e) => setDeductionForm((f) => ({ ...f, label: e.target.value }))}
                    />
                  </Field>
                  <Field label="Amount">
                    <input
                      type="number"
                      min="0.01"
                      step="0.01"
                      className={INPUT_CLASSES}
                      value={deductionForm.amount}
                      onChange={(e) => setDeductionForm((f) => ({ ...f, amount: e.target.value }))}
                    />
                  </Field>
                  <Button type="button" onClick={commitDeduction}>
                    Add deduction
                  </Button>
                </div>
              </Section>
            )}

            {/* Spec.md §13 decision 22: Manage rooms folds in everything
                the Rooms section used to render unconditionally — moving
                a room, assigning another, and charging/reverting a
                room's own stay. */}
            {rightPanel === 'manageRooms' && (
              <Section title="Manage rooms" description="Move a room, assign another, or charge that room's own stay to the folio.">
                {activeUnits.length === 0 && <EmptyState message="No rooms currently held by this booking." />}
                <ul className="flex flex-col gap-2">
                  {activeUnits.map((bu) => {
                    // Item 2's fix: a walk-up room has never had occupiedTo
                    // set — this app never collects a checkout date for it
                    // any other way — so the cashier supplies one here before
                    // the charge can be priced. A pre-arrival room (occupiedTo
                    // already set at booking time) never shows this field.
                    const needsCheckOutDate = !bu.occupiedTo;
                    // Spec.md §13 decision 31 (2026-11-16): the rate-
                    // visibility fix — null while there's nothing to
                    // price yet (a walk-up room's checkout date not
                    // typed in, or no plan selected at all).
                    const pricePreview = roomPricePreviews[bu.id];
                    // Spec.md §13 decision 19 (2026-11-06): pulled forward
                    // from the rate-rules stage — the client hit a double-
                    // posted room charge live, and this is what stops it from
                    // happening again rather than only cleaning it up after.
                    // sourceId on a ROOM charge is this same BookingUnit's own
                    // id (postFolioChargeSchema's own comment), so this is an
                    // exact match, not a guess by description text.
                    const postedCharge = folioCharges.find(
                      (c) => c.source === 'ROOM' && c.sourceId === bu.id && c.status !== 'VOIDED',
                    );
                    return (
                      <li key={bu.id} className="flex flex-col gap-2 rounded-lg border border-gray-200 p-3">
                        <div className="flex flex-col gap-2">
                          <span className="text-sm font-medium text-ink">
                            {bu.unit.code} — {bu.unit.name}
                          </span>
                          <div className="flex flex-wrap items-end gap-2">
                            {postedCharge ? (
                              <>
                                {/* The toggle's "already charged" face — obvious
                                    enough that a cashier doesn't press "Charge
                                    room to folio" a second time in the first
                                    place; Revert is the safety net for when
                                    they already have. Spec.md §13 decision 27
                                    (2026-11-15): once this charge is on an
                                    issued receipt it is no longer individually
                                    touchable — no Revert button at all, just a
                                    note pointing at voiding that receipt. */}
                                <span className="rounded-full bg-success-50 px-2 py-1 text-xs font-medium text-success-600">
                                  Charged to folio ({formatPeso(postedCharge.amount)})
                                </span>
                                {postedCharge.hasBeenReceipted ? (
                                  <span className="text-xs text-ink-secondary">
                                    On an issued receipt — void that receipt to correct it.
                                  </span>
                                ) : (
                                  <Button type="button" variant="secondary" onClick={() => void revertRoomCharge(postedCharge.id)}>
                                    Revert
                                  </Button>
                                )}
                              </>
                            ) : (
                              <div className="flex flex-col gap-2">
                                <div className="flex flex-wrap items-end gap-2">
                                  {needsCheckOutDate && (
                                    <Field label="Checkout date (walk-up — not on file)">
                                      <input
                                        type="date"
                                        className={INPUT_CLASSES}
                                        value={roomCheckOutDates[bu.id] ?? ''}
                                        onChange={(e) => setRoomCheckOutDates((d) => ({ ...d, [bu.id]: e.target.value }))}
                                      />
                                    </Field>
                                  )}
                                  {/* Relabeled 2026-11-06 (item 4's fix): the
                                      client read "Add room" (which only assigns a
                                      unit, addUnitToBooking below) as the way to
                                      add this room's own cost — "Charge room to
                                      folio" is the action that actually bills it. */}
                                  <Button
                                    type="button"
                                    variant="secondary"
                                    onClick={() => void postRoomCharge(bu.id, roomCheckOutDates[bu.id] || undefined)}
                                    disabled={(needsCheckOutDate && !roomCheckOutDates[bu.id]) || !selectedRatePlanId || pricePreview?.status === 'error'}
                                  >
                                    Charge room to folio
                                  </Button>
                                </div>
                                {/* Spec.md §13 decision 31 (2026-11-16): the
                                    Rooms-section rate-visibility fix — rate,
                                    nights, and the resulting amount, before
                                    the charge is posted, from the same
                                    pricing function the real charge uses. A
                                    failure here (RATE_PLAN_INACTIVE/
                                    RATE_PLAN_RATE_MISSING) renders right
                                    where the cashier is already looking, not
                                    only after they try to charge anyway. */}
                                {!selectedRatePlanId && (
                                  <p className="text-xs text-ink-secondary">Pick a rate plan above before charging this room.</p>
                                )}
                                {selectedRatePlanId && pricePreview?.status === 'loading' && (
                                  <p className="text-xs text-ink-secondary">Pricing…</p>
                                )}
                                {selectedRatePlanId && pricePreview?.status === 'error' && (
                                  <p role="alert" className="text-xs font-medium text-danger-600">
                                    {pricePreview.message}
                                  </p>
                                )}
                                {selectedRatePlanId && pricePreview?.status === 'ok' && (
                                  <p className="text-xs text-ink-secondary">
                                    {formatPeso(pricePreview.unitPrice)} × {pricePreview.qty} night{pricePreview.qty === 1 ? '' : 's'} ={' '}
                                    <span className="font-medium text-ink">{formatPeso(pricePreview.amount)}</span>
                                  </p>
                                )}
                              </div>
                            )}
                            <Button
                              type="button"
                              variant="secondary"
                              onClick={() => setMovingFromUnitId(movingFromUnitId === bu.id ? null : bu.id)}
                            >
                              Move
                            </Button>
                          </div>
                        </div>
                        {movingFromUnitId === bu.id && (
                          <div className="flex flex-wrap items-end gap-3">
                            <Field label="Move to (Ready only)">
                              <select className={INPUT_CLASSES} value={moveToUnitId} onChange={(e) => setMoveToUnitId(e.target.value)}>
                                <option value="">Select…</option>
                                {readyUnits.map((u) => (
                                  <option key={u.id} value={u.id}>
                                    {u.code} — {u.name}
                                  </option>
                                ))}
                              </select>
                            </Field>
                            <Button type="button" onClick={() => void handleMoveUnit(bu.unitId)} disabled={roomActionBusy || !moveToUnitId}>
                              Confirm move
                            </Button>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
                {/* Spec.md §13 decision 29 (2026-11-15): the client's own
                    concern — a three-room booking drifting across plans
                    without anyone noticing. Same confirm-and-bypass shape
                    as issueReceipt's own duplicate-billing-number warning. */}
                {pendingRatePlanMismatch && (
                  <div className="flex flex-col gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3">
                    <p className="text-sm font-medium text-amber-800">{pendingRatePlanMismatch.message}</p>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        onClick={() => void postRoomCharge(pendingRatePlanMismatch.bookingUnitId, pendingRatePlanMismatch.checkOutDate, true)}
                      >
                        Confirm anyway
                      </Button>
                      <Button type="button" variant="secondary" onClick={() => setPendingRatePlanMismatch(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
                {roomActionError && (
                  <p role="alert" className="text-sm font-medium text-danger-600">
                    {roomActionError}
                  </p>
                )}
                <div className="flex flex-col gap-3">
                  <Field label="Assign another room to this booking (Ready only)">
                    <select className={INPUT_CLASSES} value={addUnitId} onChange={(e) => setAddUnitId(e.target.value)}>
                      <option value="">Select…</option>
                      {readyUnits.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.code} — {u.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {/* Relabeled 2026-11-06 (item 4's fix): this only assigns a
                      unit (addUnitToBooking) — it never bills anything. The
                      client read this as the way to post the room's charge;
                      "Assign room" plus the field label above should no
                      longer read that way next to "Charge room to folio". */}
                  <Button type="button" variant="secondary" onClick={() => void handleAddUnit()} disabled={roomActionBusy || !addUnitId}>
                    Assign room
                  </Button>
                </div>
              </Section>
            )}

            {/* Spec.md §13 decision 22: guest contact/stay details — not
                part of the routine flow, so folded behind "Guest
                details" rather than always rendered. */}
            {rightPanel === 'guestDetails' && (
              <Section title="Guest details">
                <p className="text-sm text-ink">{preview.guest.name}</p>
                {preview.guest.address && <p className="text-sm text-ink-secondary">{preview.guest.address}</p>}
                <div className="flex flex-col gap-3">
                  <Field label="Contact No.">
                    <input className={INPUT_CLASSES} value={guestContactNo} onChange={(e) => setGuestContactNo(e.target.value)} />
                  </Field>
                  <Field label="Email">
                    <input className={INPUT_CLASSES} value={guestEmail} onChange={(e) => setGuestEmail(e.target.value)} />
                  </Field>
                  <Field label="Check-in date">
                    <input type="date" className={INPUT_CLASSES} value={checkInDate} onChange={(e) => setCheckInDate(e.target.value)} />
                  </Field>
                  <Field label="Check-out date">
                    <input type="date" className={INPUT_CLASSES} value={checkOutDate} onChange={(e) => setCheckOutDate(e.target.value)} />
                  </Field>
                  <Field label="No. of nights of stay">
                    <input
                      type="number"
                      min="1"
                      className={INPUT_CLASSES}
                      value={nightsOfStay}
                      onChange={(e) => setNightsOfStay(e.target.value)}
                    />
                  </Field>
                </div>
              </Section>
            )}

            {/* Spec.md §13 decision 22: payment history — reference
                material, looked up occasionally, not a step in taking a
                payment (that's the always-visible Take Payment panel
                above). */}
            {rightPanel === 'paymentHistory' && (
              <Section
                title="Payment history"
                description="Cash counts toward the balance immediately; GCash, bank transfer and card wait for a manager to verify them."
              >
                <DataTable columns={paymentColumns} rows={payments} rowKey={(p) => p.id} emptyMessage="No payments recorded yet." />
              </Section>
            )}

          {/* Spec.md §13 decision 25: region 3 — the working area.
              Left (wider): "Current charges", scoped explicitly to what
              the next receipt would bill — a charge leaves this list
              the instant some receipt covers it, not when a badge says
              so. Right (narrower): every issued receipt, newest first,
              always on screen — never a "Past receipts" button. */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_380px]">
            <Section
              title="Current charges"
              description="Charges not yet on an issued receipt — this is exactly what the next receipt would cover."
            >
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm text-ink-secondary">
                  {activeCharges.length === 0 ? 'Nothing to bill yet.' : `${activeCharges.length} charge(s) ready to receipt.`}
                </p>
                {/* Spec.md §13 decision 25: display-only — computed
                    server-side from booking.referenceNo, never typed.
                    A peek, not a reservation: the real number is
                    allocated atomically at issuance, inside
                    issueReceipt's own transaction. */}
                <span className="shrink-0 rounded bg-brand-50 px-3 py-1 text-sm font-semibold text-brand-700">
                  Billing No. {preview.billingNumberPreview}
                </span>
              </div>
              <DataTable
                columns={folioColumns}
                rows={activeCharges}
                rowKey={(l) => l.id}
                emptyMessage="No charges posted yet."
                renderMobileActions={folioRowActions}
              />
              {chargeError && (
                <p role="alert" className="text-sm font-medium text-danger-600">
                  {chargeError}
                </p>
              )}
              {/* Spec.md §13 decision 17: the confirm-dialog-with-
                  required-reason UX for a cashier-editable amount. The
                  audit trail (FolioChargeOverride) is what substitutes
                  for a manager approval here, so a reason is required. */}
              {overridingChargeId && (
                <div className="flex flex-col gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3">
                  <p className="text-sm font-medium text-ink">
                    Overriding {folioCharges.find((c) => c.id === overridingChargeId)?.description}
                  </p>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <Field label="New price">
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        className={INPUT_CLASSES}
                        value={overrideUnitPrice}
                        onChange={(e) => setOverrideUnitPrice(e.target.value)}
                      />
                    </Field>
                    <Field label="Reason" hint="Required — this is what the audit trail records.">
                      <input className={INPUT_CLASSES} value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} />
                    </Field>
                    <div className="flex items-end gap-2">
                      <Button type="button" onClick={() => void handleOverride()} disabled={overriding}>
                        {overriding ? 'Saving…' : 'Confirm override'}
                      </Button>
                      <Button type="button" variant="secondary" onClick={cancelOverride}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                  {overrideError && (
                    <p role="alert" className="text-sm font-medium text-danger-600">
                      {overrideError}
                    </p>
                  )}
                </div>
              )}
              {/* Spec.md §13 decision 26 (2026-11-15): the client's own
                  finding — a derived deduction appearing with no
                  cashier action and no announcement is alarming, not
                  convenient, at a counter with a guest present. Shown
                  whenever credit exists, before the totals block below
                  that would otherwise just show its effect as a fait
                  accompli — says how much, from which payment, and
                  when, and lets the cashier decide per receipt. */}
              {preview.availableCredit.length > 0 && (
                <div className="flex flex-col gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">
                  <p className="font-medium text-ink">Unapplied payment credit available</p>
                  <ul className="flex flex-col gap-1">
                    {preview.availableCredit.map((c) => (
                      <li key={c.paymentId} className="flex justify-between gap-2">
                        <span>
                          {PAYMENT_METHOD_LABELS[c.method]} —{' '}
                          {new Date(c.submittedAt).toLocaleDateString('en-PH', { timeZone: 'Asia/Manila' })}
                        </span>
                        <span>{formatPeso(c.amount)}</span>
                      </li>
                    ))}
                  </ul>
                  <label className="flex items-center gap-2 text-ink-secondary">
                    <input
                      type="checkbox"
                      checked={applyAvailableCredit}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        setApplyAvailableCredit(checked);
                        void runPreview({ applyAvailableCredit: checked });
                      }}
                    />
                    Apply this credit to this receipt
                  </label>
                </div>
              )}
              {/* Spec.md §13 decision 25: this panel's own total,
                  scoped to only these unreceipted lines — a different,
                  narrower number than the header box's whole-account
                  bridge above, clearly headed so the two are never
                  mistaken for each other. */}
              <div className="flex flex-col gap-1 rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm">
                <p className="text-xs font-medium uppercase tracking-wide text-ink-secondary">Totals for this receipt</p>
                <div className="flex justify-between">
                  <span>Grand Total</span>
                  <span>{formatPeso(preview.grandTotal)}</span>
                </div>
                <div className="flex justify-between">
                  <span>Deductions</span>
                  <span>-{formatPeso(preview.totalDeductions)}</span>
                </div>
                <div className="flex justify-between text-base font-semibold text-ink">
                  <span>Total Amount Due</span>
                  <span>{formatPeso(preview.totalAmountDue)}</span>
                </div>
              </div>
              {/* Spec.md §13 decision 26: the client's own finding — a
                  receipt reading ₱0.00 due while the account still
                  reads a balance needs explaining, or a cashier prints
                  and lets the guest leave still owing money. */}
              {preview.totalAmountDue === 0 && preview.outstandingBalance > 0 && (
                <p className="text-sm font-medium text-amber-700">
                  This receipt is fully covered, but the account still has an outstanding balance of{' '}
                  {formatPeso(preview.outstandingBalance)} from other charges or receipts.
                </p>
              )}
              <Button type="button" variant="secondary" onClick={() => void runPreview()} disabled={previewing}>
                {previewing ? 'Updating…' : 'Update preview'}
              </Button>
              {issueError && (
                <p role="alert" className="text-sm font-medium text-danger-600">
                  {issueError}
                </p>
              )}
              <form
                className="flex flex-col gap-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  void handleIssue(false);
                }}
              >
                {/* Spec.md §13 decision 25: pre-filled from the signed-
                    in user rather than blank — still editable for the
                    rare case someone else actually prepared it. */}
                <Field label="Prepared by">
                  <input className={INPUT_CLASSES} value={preparedByName} onChange={(e) => setPreparedByName(e.target.value)} />
                </Field>
                <Button type="submit" disabled={issuing || !preparedByName.trim() || preview.lines.length === 0}>
                  {issuing ? 'Issuing…' : 'Issue receipt'}
                </Button>
              </form>
            </Section>

            {/* Spec.md §13 decision 25: the receipts stack — every
                issued receipt for this booking, newest first
                (listReceiptsForBooking's own issuedAt: 'desc' order),
                each card self-contained: its own lines, its own
                totals, its own View/Void. Nothing here is behind a
                click. */}
            <div className="flex flex-col gap-4">
              <h2 className="text-base font-semibold text-ink">Receipts</h2>
              {receiptVoidError && (
                <p role="alert" className="text-sm font-medium text-danger-600">
                  {receiptVoidError}
                </p>
              )}
              {receipts.length === 0 && <EmptyState message="No receipts issued yet." />}
              {receipts.map((r) => (
                <Card key={r.id}>
                  <div className="flex flex-col gap-3">
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="text-sm font-semibold text-ink">{r.billingNumberFull}</h3>
                      {r.status === 'VOIDED' && (
                        <span className="rounded-full bg-gray-200 px-2 py-0.5 text-xs font-medium text-ink-secondary">Voided</span>
                      )}
                    </div>
                    {/* Spec.md §13 decision 27 (2026-11-15): no more
                        per-line voided cross-reference — a receipted
                        charge is no longer individually touchable, so
                        its lines here can never disagree with the
                        card's own frozen total. A whole receipt is
                        either live or voided; see the card-level strike
                        below for the latter. */}
                    <ul className="flex flex-col gap-1 text-sm">
                      {r.lines.map((line, i) => (
                        <li key={i} className="flex justify-between gap-2">
                          <span>{line.description}</span>
                          <span>{formatPeso(line.amount)}</span>
                        </li>
                      ))}
                    </ul>
                    {/* Spec.md §13 decision 26 (2026-11-15): the
                        client's own finding — "Total Amount Due" here
                        read as live debt next to the header's own
                        "Amount due", when it's really the grand total
                        this receipt covered at issuance, frozen
                        (decision 13's immutable snapshot). Payments
                        since then have moved the real, current balance
                        — which only ever belongs in the header, never
                        duplicated here. A voided receipt's total is
                        struck through, same treatment as a voided line
                        above — it owes nothing, and (decision 20) its
                        charges are back in "Current charges" now, so
                        this total describes history, not a live debt
                        either way. */}
                    <div
                      className={`flex justify-between border-t border-gray-200 pt-1 text-sm font-semibold text-ink ${r.status === 'VOIDED' ? 'text-ink-secondary line-through' : ''}`}
                    >
                      <span>Grand Total</span>
                      <span>{formatPeso(r.grandTotal)}</span>
                    </div>
                    <div className="flex gap-2">
                      <Button variant="secondary" onClick={() => void viewReceipt(r.id)}>
                        View
                      </Button>
                      {r.status !== 'VOIDED' && (
                        <Button
                          variant="secondary"
                          onClick={() => {
                            setVoidingReceiptId(r.id);
                            setReceiptVoidReason('');
                            setReceiptVoidError(null);
                          }}
                        >
                          Void
                        </Button>
                      )}
                    </div>
                    {/* Spec.md §13 decision 20: voiding releases this
                        receipt's charges back to "Current charges" for
                        re-billing (decision 18's incremental exclusion
                        — no special-case code needed for that). */}
                    {voidingReceiptId === r.id && (
                      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3">
                        <Field label="Reason" hint="Required — this is what the audit trail records.">
                          <input
                            className={INPUT_CLASSES}
                            value={receiptVoidReason}
                            onChange={(e) => setReceiptVoidReason(e.target.value)}
                          />
                        </Field>
                        <Button type="button" onClick={() => void handleVoidReceipt()} disabled={voidingReceipt || !receiptVoidReason.trim()}>
                          {voidingReceipt ? 'Voiding…' : 'Confirm void'}
                        </Button>
                        <Button type="button" variant="secondary" onClick={() => setVoidingReceiptId(null)}>
                          Cancel
                        </Button>
                      </div>
                    )}
                  </div>
                </Card>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// Print layout, matching the sample Acknowledgement Receipt's own
// columns (Items | Price | Quantity/Days | Total) and totals block
// shape (Grand Total / Deductions / Total Amount Due). Browser print
// only for this stage — no PDF dependency, per the approved build plan
// (§4: "ship browser-print-only in stage 1 [of printing]; add
// server-side PDF generation later only if actually needed").
// Spec.md §13 decision 20 (2026-11-06): `viewedPast` distinguishes this
// from the just-issued flow so "Receipt issued" doesn't misdescribe a
// receipt that was merely reopened via the Past Receipts table's own
// "View" action (GET /receipts/:id) — same component, same printable
// layout either way, just the header text.
function IssuedReceiptView({
  receipt,
  onStartAnother,
  viewedPast = false,
}: {
  receipt: IssuedReceipt;
  onStartAnother: () => void;
  viewedPast?: boolean;
}) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <PageHeader title={viewedPast ? 'Receipt' : 'Receipt issued'} description={receipt.billingNumberFull} />
        <div className="flex gap-3">
          <Button type="button" onClick={() => window.print()}>
            Print
          </Button>
          <Button type="button" variant="secondary" onClick={onStartAnother}>
            {viewedPast ? 'Back to billing' : 'Bill another receipt'}
          </Button>
        </div>
      </div>

      <Card className="mx-auto w-full max-w-2xl print:shadow-none">
        <div className="flex flex-col gap-4">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              {receipt.resort.logo && <img src={receipt.resort.logo.url} alt="" className="h-16 w-16 object-contain" />}
              <div className="text-sm">
                <p className="font-semibold text-ink">{receipt.resort.name}</p>
                <p className="text-ink-secondary">{receipt.resort.address}</p>
                {receipt.resort.cellNo && <p className="text-ink-secondary">Cell No. {receipt.resort.cellNo}</p>}
                {receipt.resort.contactNo && <p className="text-ink-secondary">Contact No. {receipt.resort.contactNo}</p>}
                {receipt.resort.website && <p className="text-ink-secondary">Website: {receipt.resort.website}</p>}
                {receipt.resort.facebookUrl && <p className="text-ink-secondary">Facebook: {receipt.resort.facebookUrl}</p>}
              </div>
            </div>
            <div className="rounded bg-brand-50 px-3 py-1 text-right text-sm font-semibold text-brand-700">
              Billing No.
              <br />
              {receipt.billingNumberFull}
            </div>
          </div>

          <h1 className="text-center text-lg font-semibold text-ink">ACKNOWLEDGEMENT RECEIPT</h1>

          <div className="grid grid-cols-1 gap-1 text-sm sm:grid-cols-2">
            <p>Date: {new Date(receipt.issuedAt).toLocaleDateString('en-PH', { timeZone: 'Asia/Manila' })}</p>
            <p>Bill to: {receipt.guest.name}</p>
            {receipt.guest.address && <p>Address: {receipt.guest.address}</p>}
            {receipt.guest.contactNo && <p>Contact No.: {receipt.guest.contactNo}</p>}
            {receipt.guest.email && <p>Email: {receipt.guest.email}</p>}
          </div>

          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-gray-300">
                <th className="py-1 pr-2 font-medium">Items</th>
                <th className="py-1 pr-2 font-medium">Price</th>
                <th className="py-1 pr-2 font-medium">Quantity/Days</th>
                <th className="py-1 font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              {receipt.lines.map((line, i) => (
                <tr key={i} className="border-b border-gray-100">
                  <td className="py-1 pr-2">{line.description}</td>
                  <td className="py-1 pr-2">{line.unitPrice.toLocaleString('en-PH', { minimumFractionDigits: 2 })}</td>
                  <td className="py-1 pr-2">{line.qty}</td>
                  <td className="py-1">{formatPeso(line.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="ml-auto flex w-full max-w-xs flex-col gap-1 text-sm sm:w-64">
            <div className="flex justify-between">
              <span>Grand Total</span>
              <span>{formatPeso(receipt.grandTotal)}</span>
            </div>
            {receipt.deductions.length > 0 && (
              <>
                <span className="font-medium">Deductions:</span>
                {receipt.deductions.map((d, i) => (
                  <div key={i} className="flex justify-between pl-2">
                    <span>{d.label}</span>
                    <span>-{formatPeso(d.amount)}</span>
                  </div>
                ))}
              </>
            )}
            <div className="flex justify-between border-t border-gray-300 pt-1 text-base font-semibold text-ink">
              <span>TOTAL AMOUNT DUE</span>
              <span>{formatPeso(receipt.totalAmountDue)}</span>
            </div>
            {/* Spec.md §13 decision 18: printed layout addition — the
                client's own sample receipt has no such line. */}
            <div className="flex justify-between text-ink-secondary">
              <span>Running Balance</span>
              <span>{formatPeso(receipt.outstandingBalance)}</span>
            </div>
          </div>

          <p className="text-sm text-ink-secondary">Prepared by: {receipt.preparedByName}</p>
        </div>
      </Card>
    </div>
  );
}
