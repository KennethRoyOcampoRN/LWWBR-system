import {
  FOLIO_CHARGE_SOURCE_KEYS,
  FOLIO_CHARGE_SOURCE_LABELS,
  isBookableUnitKind,
  PAYMENT_KIND_KEYS,
  PAYMENT_KIND_LABELS,
  PAYMENT_METHOD_KEYS,
  PAYMENT_METHOD_LABELS,
  PAYMENT_STATUS_LABELS,
  RECEIPT_DEDUCTION_TYPE_KEYS,
  RECEIPT_DEDUCTION_TYPE_LABELS,
  type BookingStatusKey,
  type FolioChargeSourceKey,
  type PaymentKindKey,
  type PaymentMethodKey,
  type PaymentStatusKey,
  type ReceiptDeductionTypeKey,
} from '@lwwbr/shared';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button } from '../components/Button.js';
import { Card, Section } from '../components/Card.js';
import { DataTable, type DataTableColumn } from '../components/DataTable.js';
import { EmptyState } from '../components/EmptyState.js';
import { Field, INPUT_CLASSES } from '../components/Field.js';
import { PageHeader } from '../components/PageHeader.js';
import { StatusBadge } from '../components/StatusBadge.js';
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
}

interface ComputedDeduction extends DraftDeduction {
  amount: number;
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

  const [booking, setBooking] = useState<BookingDetail | 'loading' | 'error'>('loading');
  const [folioCharges, setFolioCharges] = useState<FolioChargeRow[]>([]);
  // Spec.md §13 decision 21 (2026-11-06): voided charges stay in the
  // folio's own history (that's the point of voiding over deleting),
  // but default to hidden — a cashier working the folio shouldn't have
  // to read past them to see what's actually owed.
  const [showVoided, setShowVoided] = useState(false);
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
  // Spec.md §13 decision 19 (2026-11-06): voiding a charge from the
  // Folio table (any source) — same confirm-dialog-with-required-
  // reason shape as an override, just one text field instead of two.
  const [voidingChargeId, setVoidingChargeId] = useState<string | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [voidError, setVoidError] = useState<string | null>(null);
  const [voiding, setVoiding] = useState(false);
  // The Rooms section's own revert action reuses this same confirm
  // shape, keyed separately so a room-row revert and a Folio-table void
  // can't fight over the one open dialog.
  const [revertingBookingUnitId, setRevertingBookingUnitId] = useState<string | null>(null);
  const [revertReason, setRevertReason] = useState('');
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

  const [billingNumberTyped, setBillingNumberTyped] = useState('');
  const [preparedByName, setPreparedByName] = useState('');
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

  function draftBody() {
    return {
      guestContactNo: guestContactNo.trim() || null,
      guestEmail: guestEmail.trim() || null,
      checkInDate: checkInDate ? new Date(checkInDate).toISOString() : null,
      checkOutDate: checkOutDate ? new Date(checkOutDate).toISOString() : null,
      nightsOfStay: nightsOfStay ? Number(nightsOfStay) : null,
      preparedByName: preparedByName.trim(),
      deductions,
    };
  }

  function runPreview() {
    if (!bookingId) return Promise.resolve();
    setPreviewing(true);
    setIssueError(null);
    return api
      .post<PreviewResponse>(`/bookings/${bookingId}/receipts/preview`, draftBody())
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
  async function postRoomCharge(bookingUnitId: string, description: string, checkOutDate?: string) {
    if (!bookingId) return;
    setRoomActionError(null);
    try {
      await api.post(`/bookings/${bookingId}/folio-charges`, { source: 'ROOM', sourceId: bookingUnitId, description, checkOutDate });
      refetchFolio();
      void runPreview();
    } catch (err) {
      setRoomActionError(err instanceof ApiRequestError ? err.message : 'Could not post the room charge.');
    }
  }

  // Spec.md §13 decision 19 (2026-11-06): the undo for a double-posted
  // room charge — "Post room charge" becomes a toggle (postedRoomCharge
  // below decides which face renders), and this is its revert side.
  // Same confirm-dialog-with-required-reason UX as decision 17's
  // override, for the same reason: the audit trail (voidReason, who,
  // when — already on FolioCharge) is what substitutes for a manager's
  // approval here.
  async function revertRoomCharge(chargeId: string, reason: string) {
    setRoomActionError(null);
    try {
      await api.post(`/folio-charges/${chargeId}/void`, { voidReason: reason });
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

  function startVoidCharge(chargeId: string) {
    setVoidingChargeId(chargeId);
    setVoidReason('');
    setVoidError(null);
  }

  function cancelVoidCharge() {
    setVoidingChargeId(null);
    setVoidError(null);
  }

  async function handleVoidCharge() {
    if (!voidingChargeId || !voidReason.trim()) return;
    setVoiding(true);
    setVoidError(null);
    try {
      await api.post(`/folio-charges/${voidingChargeId}/void`, { voidReason: voidReason.trim() });
      setVoidingChargeId(null);
      refetchFolio();
      void runPreview();
    } catch (err) {
      setVoidError(err instanceof ApiRequestError ? err.message : 'Could not void this charge.');
    } finally {
      setVoiding(false);
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
        billingNumberTyped: billingNumberTyped.trim(),
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
    setBillingNumberTyped('');
    refetchFolio();
    refetchReceipts();
    void runPreview();
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
          {/* Spec.md §13 decision 19: a voided line stays visible with
              this badge rather than disappearing — the whole point of
              voiding over silently removing it. */}
          {l.status === 'VOIDED' && (
            <span className="ml-2 rounded-full bg-gray-200 px-2 py-0.5 text-xs font-medium text-ink-secondary">Voided</span>
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
      render: (l) =>
        l.status === 'VOIDED' ? null : (
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => startOverride(l)}>
              Override amount
            </Button>
            {/* Spec.md §13 decision 21 (2026-11-06): the client's own
                words, caught live-testing decision 19's void action —
                "the purpose of delete is for errors, don't make it
                hard to delete errors." Picked automatically, per
                charge: never on an issued receipt deletes outright (no
                reason — the audit extension still records it); once a
                receipt references it, voiding is the only option, same
                trade-off decision 17 already settled for overriding an
                amount — reasoned, and the charge stays visible as
                VOIDED rather than silently gone. */}
            {l.hasBeenReceipted ? (
              <Button variant="secondary" onClick={() => startVoidCharge(l.id)}>
                Void
              </Button>
            ) : (
              <Button variant="secondary" onClick={() => void handleDeleteCharge(l.id)}>
                Delete
              </Button>
            )}
          </div>
        ),
      hideOnMobile: true,
    },
  ];

  // Spec.md §13 decision 19 (2026-11-06): the Payments section's own
  // table. "Balance effect" is what makes decision 18's CASH-is-
  // immediate/others-need-verified split visible — without it the only
  // way to learn why a GCash payment didn't move the balance would be
  // to already know the rule.
  // Spec.md §13 decision 20: the past-receipts table — Void is the only
  // action, and only for a receipt not already VOIDED.
  const receiptColumns: DataTableColumn<IssuedReceipt>[] = [
    { key: 'billingNumberFull', header: 'Billing No.', render: (r) => r.billingNumberFull },
    { key: 'issuedAt', header: 'Issued', render: (r) => new Date(r.issuedAt).toLocaleString('en-PH', { timeZone: 'Asia/Manila' }) },
    { key: 'totalAmountDue', header: 'Total Amount Due', render: (r) => formatPeso(r.totalAmountDue) },
    { key: 'status', header: 'Status', render: (r) => r.status },
    {
      key: 'actions',
      header: 'Actions',
      render: (r) => (
        <div className="flex gap-2">
          {/* Spec.md §13 decision 20: GET /receipts/:id had no caller
              either — the Past Receipts table below only ever showed
              summary columns, with no way to see or reprint the full
              document once issued. Reuses the exact printable view the
              just-issued receipt already renders. */}
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
      ),
      hideOnMobile: true,
    },
  ];

  const paymentColumns: DataTableColumn<PaymentRow>[] = [
    { key: 'method', header: 'Method', render: (p) => PAYMENT_METHOD_LABELS[p.method] },
    { key: 'amount', header: 'Amount', render: (p) => formatPeso(p.amount) },
    { key: 'kind', header: 'Kind', render: (p) => PAYMENT_KIND_LABELS[p.kind] },
    { key: 'submittedAt', header: 'When', render: (p) => new Date(p.submittedAt).toLocaleString('en-PH', { timeZone: 'Asia/Manila' }) },
    { key: 'submittedBy', header: 'Recorded by', render: (p) => p.submittedBy.fullName },
    { key: 'status', header: 'Status', render: (p) => PAYMENT_STATUS_LABELS[p.status] },
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

      {booking !== 'loading' && booking !== 'error' && (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-ink">{booking.guestName}</p>
              <p className="text-xs text-ink-secondary">Booking ID {booking.referenceNo}</p>
            </div>
            <StatusBadge variant={BOOKING_STATUS_BADGE_VARIANT[booking.status]}>
              {BOOKING_STATUS_LABELS[booking.status]}
            </StatusBadge>
          </div>

          {/* Re-plan, spec.md §13 decision 16: resolving a CONFIRMED
              (pre-arrival) booking — the guest actually arrives, or
              doesn't. Manual only, no automatic no-show timer. */}
          {booking.status === 'CONFIRMED' && (
            <div className="mt-4 flex flex-col gap-2">
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
          )}
        </Card>
      )}

      {booking !== 'loading' && booking !== 'error' && (
        <Section title="Rooms" description="Move a room, assign another, or charge that room's own stay to the folio.">
          {activeUnits.length === 0 && <EmptyState message="No rooms currently held by this booking." />}
          <ul className="flex flex-col gap-2">
            {activeUnits.map((bu) => {
              // Item 2's fix: a walk-up room has never had occupiedTo
              // set — this app never collects a checkout date for it
              // any other way — so the cashier supplies one here before
              // the charge can be priced. A pre-arrival room (occupiedTo
              // already set at booking time) never shows this field.
              const needsCheckOutDate = !bu.occupiedTo;
              const description = `${bu.unit.unitTypeName} (${bu.unit.code})`;
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
              const isReverting = revertingBookingUnitId === bu.id;
              return (
                <li key={bu.id} className="flex flex-col gap-2 rounded-lg border border-gray-200 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
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
                              they already have. */}
                          <span className="rounded-full bg-success-50 px-2 py-1 text-xs font-medium text-success-600">
                            Charged to folio ({formatPeso(postedCharge.amount)})
                          </span>
                          <Button type="button" variant="secondary" onClick={() => setRevertingBookingUnitId(isReverting ? null : bu.id)}>
                            Revert
                          </Button>
                        </>
                      ) : (
                        <>
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
                            onClick={() => void postRoomCharge(bu.id, description, roomCheckOutDates[bu.id] || undefined)}
                            disabled={needsCheckOutDate && !roomCheckOutDates[bu.id]}
                          >
                            Charge room to folio
                          </Button>
                        </>
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
                  {isReverting && postedCharge && (
                    <div className="flex flex-wrap items-end gap-3 rounded border border-amber-300 bg-amber-50 p-2">
                      <Field label="Reason" hint="Required — this is what the audit trail records.">
                        <input className={INPUT_CLASSES} value={revertReason} onChange={(e) => setRevertReason(e.target.value)} />
                      </Field>
                      <Button
                        type="button"
                        onClick={async () => {
                          await revertRoomCharge(postedCharge.id, revertReason.trim());
                          setRevertingBookingUnitId(null);
                          setRevertReason('');
                        }}
                        disabled={!revertReason.trim()}
                      >
                        Confirm revert
                      </Button>
                      <Button type="button" variant="secondary" onClick={() => setRevertingBookingUnitId(null)}>
                        Cancel
                      </Button>
                    </div>
                  )}
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
          {roomActionError && (
            <p role="alert" className="text-sm font-medium text-danger-600">
              {roomActionError}
            </p>
          )}
          <div className="flex flex-wrap items-end gap-3">
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

      {preview === 'loading' && <p className="text-sm text-ink-secondary">Loading…</p>}
      {preview === 'error' && <p role="alert">Could not load this booking.</p>}

      {preview !== 'loading' && preview !== 'error' && (
        <>
          <Section title="Guest">
            <p className="text-sm text-ink">{preview.guest.name}</p>
            {preview.guest.address && <p className="text-sm text-ink-secondary">{preview.guest.address}</p>}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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

          {/* Re-plan, spec.md §13 decision 16: the folio itself — read
              only. previewReceipt/issueReceipt build their lines from
              these same posted FolioCharge rows (gathered across every
              sibling booking), so nothing typed here could ever drift
              from what gets billed. */}
          <Section title="Folio" description="Every charge posted to this booking (and any sibling room sharing its booking ID).">
            <label className="flex items-center gap-2 text-sm text-ink-secondary">
              <input type="checkbox" checked={showVoided} onChange={(e) => setShowVoided(e.target.checked)} />
              Show voided charges
            </label>
            <DataTable
              columns={folioColumns}
              rows={folioCharges.filter((l) => showVoided || l.status !== 'VOIDED')}
              rowKey={(l) => l.id}
              emptyMessage="No charges posted yet."
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
            {/* Spec.md §13 decision 19: voiding from the Folio table —
                same confirm-dialog-with-required-reason shape as the
                override above. */}
            {voidingChargeId && (
              <div className="flex flex-col gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3">
                <p className="text-sm font-medium text-ink">Voiding {folioCharges.find((c) => c.id === voidingChargeId)?.description}</p>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <Field label="Reason" hint="Required — this is what the audit trail records.">
                    <input className={INPUT_CLASSES} value={voidReason} onChange={(e) => setVoidReason(e.target.value)} />
                  </Field>
                  <div className="flex items-end gap-2">
                    <Button type="button" onClick={() => void handleVoidCharge()} disabled={voiding || !voidReason.trim()}>
                      {voiding ? 'Voiding…' : 'Confirm void'}
                    </Button>
                    <Button type="button" variant="secondary" onClick={cancelVoidCharge}>
                      Cancel
                    </Button>
                  </div>
                </div>
                {voidError && (
                  <p role="alert" className="text-sm font-medium text-danger-600">
                    {voidError}
                  </p>
                )}
              </div>
            )}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-5">
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
              <div className="flex items-end">
                <Button type="button" onClick={() => void handlePostCharge()} disabled={postingCharge}>
                  {postingCharge ? 'Posting…' : 'Post charge'}
                </Button>
              </div>
            </div>
          </Section>

          {/* Cashier-tab plan, Stage B (2026-11-05): the F&B pull-in —
              unsettled charge-to-room orders across every sibling
              booking, one click each to post to the folio. */}
          <Section title="Restaurant charges not yet on the folio">
            {unsettledFnb.length === 0 && <EmptyState message="Nothing unsettled." />}
            <ul className="flex flex-col gap-2">
              {unsettledFnb.map((c) => (
                <li key={c.fnbOrderId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-gray-200 p-3 text-sm">
                  <span>
                    {c.unit.code} — Order {c.referenceNo} — {formatPeso(c.subtotal)}
                  </span>
                  <Button type="button" variant="secondary" onClick={() => void pullInFnbCharge(c)}>
                    Add to folio
                  </Button>
                </li>
              ))}
            </ul>
            {/* Found in the same sweep as item 1's fix: pullInFnbCharge
                sets chargeError too, but its own trigger ("Add to
                folio") lives in this section, not the Folio section
                where chargeError otherwise renders. */}
            {chargeError && (
              <p role="alert" className="text-sm font-medium text-danger-600">
                {chargeError}
              </p>
            )}
          </Section>

          {/* Spec.md §13 decision 19 (2026-11-06): without this section
              decision 18's entire backend (CASH-immediate, settlement
              draw-down, the derived DOWNPAYMENT deduction,
              outstandingBalance) was unreachable — there was nowhere
              for a cashier to actually record a payment. */}
          <Section
            title="Payments"
            description="Record a payment against this booking. Cash counts toward the balance immediately; GCash, bank transfer and card wait for a manager to verify them."
          >
            <DataTable columns={paymentColumns} rows={payments} rowKey={(p) => p.id} emptyMessage="No payments recorded yet." />
            {paymentError && (
              <p role="alert" className="text-sm font-medium text-danger-600">
                {paymentError}
              </p>
            )}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-5">
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
              <div className="flex items-end">
                <Button type="button" onClick={() => void handleSubmitPayment()} disabled={postingPayment}>
                  {postingPayment ? 'Recording…' : 'Record payment'}
                </Button>
              </div>
            </div>
            {/* The number the cashier is actually working toward —
                shown here too, not just in Totals further down, since
                that's the whole point of recording a payment. */}
            {previewData && (
              <p className="text-sm font-medium text-ink">Outstanding balance: {formatPeso(previewData.outstandingBalance)}</p>
            )}
          </Section>

          <Section title="Deductions">
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
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
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
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
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
              <div className="flex items-end">
                <Button type="button" onClick={commitDeduction}>
                  Add deduction
                </Button>
              </div>
            </div>
          </Section>

          <Section title="Totals">
            <Button type="button" variant="secondary" onClick={() => void runPreview()} disabled={previewing}>
              {previewing ? 'Updating…' : 'Update preview'}
            </Button>
            {issueError && (
              <p role="alert" className="text-sm font-medium text-danger-600">
                {issueError}
              </p>
            )}
            <div className="flex flex-col gap-1 text-sm">
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
              {/* Spec.md §13 decision 18: the whole-account running
                  balance — a layout addition the client's own sample
                  receipt doesn't have. */}
              <div className="flex justify-between text-ink-secondary">
                <span>Running Balance</span>
                <span>{formatPeso(preview.outstandingBalance)}</span>
              </div>
            </div>
          </Section>

          <Card>
            <div className="flex flex-col gap-4">
              <h2 className="text-base font-semibold text-ink">Issue receipt</h2>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Billing No." hint="Typed from the pre-printed receipt booklet.">
                  <input
                    className={INPUT_CLASSES}
                    value={billingNumberTyped}
                    onChange={(e) => setBillingNumberTyped(e.target.value)}
                  />
                </Field>
                <Field label="Prepared by">
                  <input className={INPUT_CLASSES} value={preparedByName} onChange={(e) => setPreparedByName(e.target.value)} />
                </Field>
              </div>
              {/* Found in the same sweep as item 1's fix: handleIssue's
                  own catch sets issueError too, but this button is the
                  one that triggers it — the Totals section above (where
                  issueError otherwise renders) isn't where this click
                  happens, so an issue failure needs showing here too. */}
              {issueError && (
                <p role="alert" className="text-sm font-medium text-danger-600">
                  {issueError}
                </p>
              )}
              <Button
                type="button"
                onClick={() => void handleIssue(false)}
                disabled={issuing || !billingNumberTyped.trim() || !preparedByName.trim() || preview.lines.length === 0}
              >
                {issuing ? 'Issuing…' : 'Issue receipt'}
              </Button>
            </div>
          </Card>

          {/* Spec.md §13 decision 20 (2026-11-06): POST /receipts/:id/void
              existed with no caller anywhere in the frontend — a receipt
              issued in error was permanent. Matters more now that
              receipts are incremental (decision 18): voiding is what
              releases a receipt's charges back to be re-billed, so a
              mistaken receipt doesn't strand them. */}
          <Section title="Past receipts">
            <DataTable columns={receiptColumns} rows={receipts} rowKey={(r) => r.id} emptyMessage="No receipts issued yet." />
            {receiptVoidError && (
              <p role="alert" className="text-sm font-medium text-danger-600">
                {receiptVoidError}
              </p>
            )}
            {voidingReceiptId && (
              <div className="flex flex-wrap items-end gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3">
                <Field label="Reason" hint="Required — this is what the audit trail records.">
                  <input className={INPUT_CLASSES} value={receiptVoidReason} onChange={(e) => setReceiptVoidReason(e.target.value)} />
                </Field>
                <Button type="button" onClick={() => void handleVoidReceipt()} disabled={voidingReceipt || !receiptVoidReason.trim()}>
                  {voidingReceipt ? 'Voiding…' : 'Confirm void'}
                </Button>
                <Button type="button" variant="secondary" onClick={() => setVoidingReceiptId(null)}>
                  Cancel
                </Button>
              </div>
            )}
          </Section>
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
