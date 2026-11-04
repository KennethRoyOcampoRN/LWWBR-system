import { RECEIPT_DEDUCTION_TYPE_KEYS, RECEIPT_DEDUCTION_TYPE_LABELS, type ReceiptDeductionTypeKey } from '@lwwbr/shared';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Button } from '../components/Button.js';
import { Card, Section } from '../components/Card.js';
import { DataTable, type DataTableColumn } from '../components/DataTable.js';
import { Field, INPUT_CLASSES } from '../components/Field.js';
import { PageHeader } from '../components/PageHeader.js';
import { api, ApiRequestError } from '../lib/api.js';

interface UnitTypeRow {
  id: string;
  name: string;
  baseRate: number;
  dayTourRate: number | null;
  extraPersonRate: number | null;
}

interface DraftLine {
  description: string;
  qty: number;
  unitPrice: number;
}

interface DraftDeduction {
  type: ReceiptDeductionTypeKey;
  label: string;
  amount: number;
}

interface ComputedLine extends DraftLine {
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

const EMPTY_LINE_FORM = { description: '', qty: '1', unitPrice: '' };
const EMPTY_DEDUCTION_FORM = { type: 'DOWNPAYMENT' as ReceiptDeductionTypeKey, label: 'Downpayment', amount: '' };

function formatPeso(amount: number): string {
  return `₱${amount.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Build plan stage 4 (spec.md §13 decision 13, 2026-11-04): the
// cashier-facing billing page. Reached from UnitsPage's own "Bill
// guest" link on a booking row (there's no standalone "pick a booking"
// screen — the same booking-by-id entry point Check out already uses).
// Builds a draft receipt (room/extra-person/other line quick-picks,
// deduction rows), previews it against the real server-side
// computation (POST .../receipts/preview — same calculation
// issueReceipt uses, see billing/service.ts's own comment on why they
// share computeReceiptTotals), then issues it. The first preview call
// fires with no lines at all, purely to fetch the resort header/guest
// block server-side (receiptDraftSchema allows this — see its own
// comment) since there's no standalone booking-read endpoint this page
// could call instead.
export function BillingPage() {
  const { bookingId } = useParams<{ bookingId: string }>();

  const [unitTypes, setUnitTypes] = useState<UnitTypeRow[]>([]);
  const [preview, setPreview] = useState<PreviewResponse | 'loading' | 'error'>('loading');
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [deductions, setDeductions] = useState<DraftDeduction[]>([]);
  const [lineForm, setLineForm] = useState(EMPTY_LINE_FORM);
  const [selectedUnitTypeId, setSelectedUnitTypeId] = useState('');
  const [deductionForm, setDeductionForm] = useState(EMPTY_DEDUCTION_FORM);

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
      lines,
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
        // First successful preview also seeds the guest-contact inputs
        // from the booking's own record, if the cashier hasn't typed
        // anything yet — a convenience, not an override once edited.
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

  useEffect(() => {
    void runPreview();
    api
      .get<{ unitTypes: UnitTypeRow[] }>('/unit-types')
      .then((res) => setUnitTypes(res.unitTypes))
      .catch(() => setUnitTypes([]));
    // Only on mount (keyed on bookingId) — every later recompute is the
    // cashier explicitly clicking "Update preview" below, not an
    // auto-refetch on every keystroke.
  }, [bookingId]);

  function addRoomLine() {
    const unitType = unitTypes.find((u) => u.id === selectedUnitTypeId);
    if (!unitType) return;
    setLineForm({ description: unitType.name, qty: '1', unitPrice: String(unitType.baseRate) });
  }

  function addExtraPersonLine() {
    const unitType = unitTypes.find((u) => u.id === selectedUnitTypeId);
    if (!unitType || unitType.extraPersonRate === null) return;
    setLineForm({ description: `${unitType.name} — extra person`, qty: '1', unitPrice: String(unitType.extraPersonRate) });
  }

  function commitLine() {
    const qty = Number(lineForm.qty);
    const unitPrice = Number(lineForm.unitPrice);
    if (!lineForm.description.trim() || !Number.isInteger(qty) || qty < 1 || !(unitPrice >= 0)) return;
    setLines((ls) => [...ls, { description: lineForm.description.trim(), qty, unitPrice }]);
    setLineForm(EMPTY_LINE_FORM);
    setSelectedUnitTypeId('');
  }

  function removeLine(index: number) {
    setLines((ls) => ls.filter((_, i) => i !== index));
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
    setLines([]);
    setDeductions([]);
    setBillingNumberTyped('');
    void runPreview();
  }

  const lineColumns: DataTableColumn<ComputedLine & { index: number }>[] = [
    { key: 'description', header: 'Items', render: (l) => l.description },
    { key: 'unitPrice', header: 'Price', render: (l) => formatPeso(l.unitPrice) },
    { key: 'qty', header: 'Quantity/Days', render: (l) => l.qty },
    { key: 'amount', header: 'Total', render: (l) => formatPeso(l.amount) },
    {
      key: 'actions',
      header: 'Actions',
      render: (l) => (
        <Button variant="secondary" onClick={() => removeLine(l.index)}>
          Remove
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

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Bill guest" description="Builds an Acknowledgement Receipt for this booking." />

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

          <Section title="Line items">
            <DataTable
              columns={lineColumns}
              rows={lines.map((l, index) => ({ ...l, amount: l.qty * l.unitPrice, index }))}
              rowKey={(l) => String(l.index)}
              emptyMessage="No line items yet."
              renderMobileActions={(l) => (
                <Button variant="secondary" onClick={() => removeLine(l.index)}>
                  Remove
                </Button>
              )}
            />
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Unit type (for Room / Extra person)">
                <select className={INPUT_CLASSES} value={selectedUnitTypeId} onChange={(e) => setSelectedUnitTypeId(e.target.value)}>
                  <option value="">Select…</option>
                  {unitTypes.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Button type="button" variant="secondary" onClick={addRoomLine} disabled={!selectedUnitTypeId}>
                Fill Room
              </Button>
              <Button type="button" variant="secondary" onClick={addExtraPersonLine} disabled={!selectedUnitTypeId}>
                Fill Extra person
              </Button>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
              <Field label="Description">
                <input
                  className={INPUT_CLASSES}
                  value={lineForm.description}
                  onChange={(e) => setLineForm((f) => ({ ...f, description: e.target.value }))}
                />
              </Field>
              <Field label="Quantity/Days">
                <input
                  type="number"
                  min="1"
                  className={INPUT_CLASSES}
                  value={lineForm.qty}
                  onChange={(e) => setLineForm((f) => ({ ...f, qty: e.target.value }))}
                />
              </Field>
              <Field label="Price">
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  className={INPUT_CLASSES}
                  value={lineForm.unitPrice}
                  onChange={(e) => setLineForm((f) => ({ ...f, unitPrice: e.target.value }))}
                />
              </Field>
              <div className="flex items-end">
                <Button type="button" onClick={commitLine}>
                  Add line
                </Button>
              </div>
            </div>
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
              <Button
                type="button"
                onClick={() => void handleIssue(false)}
                disabled={issuing || !billingNumberTyped.trim() || !preparedByName.trim() || lines.length === 0}
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
