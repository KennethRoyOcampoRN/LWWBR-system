import { PAYMENT_METHOD_LABELS, PAYMENT_STATUS_LABELS, type PaymentMethodKey, type PaymentStatusKey } from '@lwwbr/shared';
import { useEffect, useState } from 'react';
import { Button } from '../components/Button.js';
import { DataTable, type DataTableColumn } from '../components/DataTable.js';
import { Field, INPUT_CLASSES } from '../components/Field.js';
import { PageHeader } from '../components/PageHeader.js';
import { api, ApiRequestError } from '../lib/api.js';

function formatPeso(amount: number): string {
  return `₱${amount.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Spec.md §13 decision 20 (2026-11-06): the surface payment:verify
// actually needs. CASH is effective on record and never shows up
// here needing anything — this page is specifically for the four
// methods (GCash, bank transfer, card, other) that stay in the
// submit-then-verify flow until someone with payment:verify
// (System Admin/Owner/Resort Manager/Admin Head) acts on them.
// Property-wide, not opened from one booking's billing page, since
// the point is reviewing submitted proof across every booking at once.
interface PendingPaymentRow {
  id: string;
  amount: number;
  method: PaymentMethodKey;
  referenceNo: string | null;
  status: PaymentStatusKey;
  submittedAt: string;
  submittedBy: { fullName: string };
  verifiedBy: { fullName: string } | null;
  rejectionReason: string | null;
  booking: { referenceNo: string; guestName: string } | null;
}

export function PendingPaymentsPage() {
  const [payments, setPayments] = useState<PendingPaymentRow[] | 'loading' | 'error'>('loading');
  const [actionError, setActionError] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectionReason, setRejectionReason] = useState('');

  function fetchPending() {
    setPayments('loading');
    return api
      .get<{ payments: PendingPaymentRow[] }>('/payments?status=PENDING')
      .then((res) => setPayments(res.payments))
      .catch(() => setPayments('error'));
  }

  useEffect(() => {
    void fetchPending();
  }, []);

  async function verify(id: string) {
    setActionError(null);
    try {
      await api.post(`/payments/${id}/status`, { toStatus: 'VERIFIED' });
      await fetchPending();
    } catch (err) {
      setActionError(err instanceof ApiRequestError ? err.message : 'Could not verify this payment.');
    }
  }

  function startReject(id: string) {
    setRejectingId(id);
    setRejectionReason('');
    setActionError(null);
  }

  async function confirmReject() {
    if (!rejectingId || !rejectionReason.trim()) return;
    setActionError(null);
    try {
      await api.post(`/payments/${rejectingId}/status`, { toStatus: 'REJECTED', rejectionReason: rejectionReason.trim() });
      setRejectingId(null);
      setRejectionReason('');
      await fetchPending();
    } catch (err) {
      setActionError(err instanceof ApiRequestError ? err.message : 'Could not reject this payment.');
    }
  }

  const columns: DataTableColumn<PendingPaymentRow>[] = [
    { key: 'booking', header: 'Booking', render: (p) => (p.booking ? `${p.booking.guestName} (${p.booking.referenceNo})` : '—') },
    { key: 'method', header: 'Method', render: (p) => PAYMENT_METHOD_LABELS[p.method] },
    { key: 'amount', header: 'Amount', render: (p) => formatPeso(p.amount) },
    { key: 'referenceNo', header: 'Reference No.', render: (p) => p.referenceNo ?? '—' },
    { key: 'submittedAt', header: 'Submitted', render: (p) => new Date(p.submittedAt).toLocaleString('en-PH', { timeZone: 'Asia/Manila' }) },
    { key: 'submittedBy', header: 'By', render: (p) => p.submittedBy.fullName },
    { key: 'status', header: 'Status', render: (p) => PAYMENT_STATUS_LABELS[p.status] },
    {
      key: 'actions',
      header: 'Actions',
      render: (p) => (
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => void verify(p.id)}>
            Verify
          </Button>
          <Button variant="secondary" onClick={() => startReject(p.id)}>
            Reject
          </Button>
        </div>
      ),
      hideOnMobile: true,
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Payment Verification"
        description="GCash, bank transfer, card and other non-cash payments awaiting verification before they count toward a booking's balance."
      />
      {actionError && (
        <p role="alert" className="text-sm font-medium text-danger-600">
          {actionError}
        </p>
      )}
      <DataTable
        columns={columns}
        rows={payments}
        rowKey={(p) => p.id}
        emptyMessage="Nothing awaiting verification."
        renderMobileActions={(p) => (
          <>
            <Button variant="secondary" onClick={() => void verify(p.id)}>
              Verify
            </Button>
            <Button variant="secondary" onClick={() => startReject(p.id)}>
              Reject
            </Button>
          </>
        )}
      />
      {rejectingId && (
        <div className="flex flex-wrap items-end gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3">
          <Field label="Rejection reason" hint="Required.">
            <input className={INPUT_CLASSES} value={rejectionReason} onChange={(e) => setRejectionReason(e.target.value)} />
          </Field>
          <Button type="button" onClick={() => void confirmReject()} disabled={!rejectionReason.trim()}>
            Confirm reject
          </Button>
          <Button type="button" variant="secondary" onClick={() => setRejectingId(null)}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}
