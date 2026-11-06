import {
  FOLIO_CHARGE_SOURCE_KEYS,
  FOLIO_CHARGE_SOURCE_LABELS,
  isBookableUnitKind,
  RECEIPT_DEDUCTION_TYPE_KEYS,
  RECEIPT_DEDUCTION_TYPE_LABELS,
  type BookingStatusKey,
  type FolioChargeSourceKey,
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

interface FolioChargeRow {
  id: string;
  bookingId: string;
  source: FolioChargeSourceKey;
  description: string;
  qty: number;
  unitPrice: number;
  amount: number;
  status: string;
}

interface UnsettledFnbCharge {
  fnbOrderId: string;
  referenceNo: string;
  bookingId: string;
  unit: { id: string; code: string; name: string };
  subtotal: number;
  createdAt: string;
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

const EMPTY_CHARGE_FORM = { source: NON_ROOM_SOURCE_KEYS[0] as FolioChargeSourceKey, description: '', qty: '1', unitPrice: '' };
const EMPTY_DEDUCTION_FORM = { type: 'DOWNPAYMENT' as ReceiptDeductionTypeKey, label: 'Downpayment', amount: '' };

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
  const [unsettledFnb, setUnsettledFnb] = useState<UnsettledFnbCharge[]>([]);
  const [readyUnits, setReadyUnits] = useState<ReadyUnit[]>([]);
  const [preview, setPreview] = useState<PreviewResponse | 'loading' | 'error'>('loading');
  const [deductions, setDeductions] = useState<DraftDeduction[]>([]);
  const [deductionForm, setDeductionForm] = useState(EMPTY_DEDUCTION_FORM);
  const [chargeForm, setChargeForm] = useState(EMPTY_CHARGE_FORM);
  const [postingCharge, setPostingCharge] = useState(false);
  const [chargeError, setChargeError] = useState<string | null>(null);
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
    setDeductions([]);
    setBillingNumberTyped('');
    refetchFolio();
    void runPreview();
  }

  const folioColumns: DataTableColumn<FolioChargeRow>[] = [
    { key: 'description', header: 'Items', render: (l) => l.description },
    { key: 'source', header: 'Source', render: (l) => FOLIO_CHARGE_SOURCE_LABELS[l.source] },
    { key: 'unitPrice', header: 'Price', render: (l) => formatPeso(l.unitPrice) },
    { key: 'qty', header: 'Quantity/Days', render: (l) => l.qty },
    { key: 'amount', header: 'Total', render: (l) => formatPeso(l.amount) },
  ];

  const deductionColumns: DataTableColumn<ComputedDeduction & { index: number }>[] = [
    { key: 'label', header: 'Deduction', render: (d) => d.label },
    { key: 'type', header: 'Type', render: (d) => RECEIPT_DEDUCTION_TYPE_LABELS[d.type] },
    { key: 'amount', header: 'Amount', render: (d) => `-${formatPeso(d.amount)}` },
    {
      key: 'actions',
      header: 'Actions',
      render: (d) => (
        <Button variant="secondary" onClick={() => removeDeduction(d.index)}>
          Remove
        </Button>
      ),
      hideOnMobile: true,
    },
  ];

  if (issuedReceipt) {
    return <IssuedReceiptView receipt={issuedReceipt} onStartAnother={startAnotherReceipt} />;
  }

  const activeUnits = booking !== 'loading' && booking !== 'error' ? booking.units.filter((u) => !u.releasedAt) : [];

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
              return (
                <li key={bu.id} className="flex flex-col gap-2 rounded-lg border border-gray-200 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-medium text-ink">
                      {bu.unit.code} — {bu.unit.name}
                    </span>
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
                      {/* Relabeled 2026-11-06 (item 4's fix): the client
                          read "Add room" (which only assigns a unit,
                          addUnitToBooking below) as the way to add this
                          room's own cost — "Charge room to folio" is
                          the action that actually bills it. */}
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={() => void postRoomCharge(bu.id, description, roomCheckOutDates[bu.id] || undefined)}
                        disabled={needsCheckOutDate && !roomCheckOutDates[bu.id]}
                      >
                        Charge room to folio
                      </Button>
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
            <DataTable columns={folioColumns} rows={folioCharges} rowKey={(l) => l.id} emptyMessage="No charges posted yet." />
            {chargeError && (
              <p role="alert" className="text-sm font-medium text-danger-600">
                {chargeError}
              </p>
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

          <Section title="Deductions">
            <DataTable
              columns={deductionColumns}
              rows={deductions.map((d, index) => ({ ...d, index }))}
              rowKey={(d) => String(d.index)}
              emptyMessage="No deductions."
              renderMobileActions={(d) => (
                <Button variant="secondary" onClick={() => removeDeduction(d.index)}>
                  Remove
                </Button>
              )}
            />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
              <Field label="Type">
                <select
                  className={INPUT_CLASSES}
                  value={deductionForm.type}
                  onChange={(e) =>
                    setDeductionForm((f) => ({ ...f, type: e.target.value as ReceiptDeductionTypeKey }))
                  }
                >
                  {RECEIPT_DEDUCTION_TYPE_KEYS.map((key) => (
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
function IssuedReceiptView({ receipt, onStartAnother }: { receipt: IssuedReceipt; onStartAnother: () => void }) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <PageHeader title="Receipt issued" description={receipt.billingNumberFull} />
        <div className="flex gap-3">
          <Button type="button" onClick={() => window.print()}>
            Print
          </Button>
          <Button type="button" variant="secondary" onClick={onStartAnother}>
            Bill another receipt
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
          </div>

          <p className="text-sm text-ink-secondary">Prepared by: {receipt.preparedByName}</p>
        </div>
      </Card>
    </div>
  );
}
