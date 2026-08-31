import { REMITTANCE_STATUS_LABELS } from '@lwwbr/shared';
import { useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import { EmptyState } from '../components/EmptyState.js';
import { SkeletonTableRows } from '../components/Skeleton.js';
import { useAuth } from '../context/AuthContext.js';
import { api, ApiRequestError } from '../lib/api.js';
import { REMITTANCE_STATUS_CLASSES } from '../lib/remittanceStyle.js';

interface RemittanceRequestRow {
  id: string;
  referenceNo: string;
  name: string;
  date: string;
  modeOfPayment: string;
  amount: number;
  referenceNumber: string;
  status: 'FOR_VERIFICATION' | 'VERIFIED';
  // A real signed URL, generated server-side per request — see
  // remittances/service.ts's own comment for why there's no generic
  // GET /files/:id route to link to directly.
  proofFile: { id: string; filename: string; url: string } | null;
  createdBy: { fullName: string };
  verifiedBy: { fullName: string } | null;
}

function formatPeso(amount: number): string {
  return `₱${amount.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const initialFormState = {
  name: '',
  date: '',
  modeOfPayment: '',
  amount: '',
  referenceNumber: '',
};

// Spec §11 (client-directed feature, 2026-08-31): an incoming guest
// payment (a manually-booked guest paid via bank transfer/GCash/etc.)
// submitted for OWNER to verify. Pure standalone record — no
// unit/booking/folio link, same "monitoring, not transactions" boundary
// as the rest of this app. See rolePermissions.ts's own comment for why
// this is remittance:*, not payment:* (that namespace is reserved for
// the descoped Payment/Folio/CashCount system, spec §13 decision 7).
export function RemittancePage() {
  const { user } = useAuth();
  const canCreate = Boolean(user?.permissions['remittance:create']);
  const canVerify = Boolean(user?.permissions['remittance:verify']);

  const [requests, setRequests] = useState<RemittanceRequestRow[] | 'loading' | 'error'>('loading');
  const [form, setForm] = useState(initialFormState);
  const [proofFile, setProofFile] = useState<{ fileId: string; filename: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  function fetchRequests() {
    setRequests('loading');
    return api
      .get<{ remittanceRequests: RemittanceRequestRow[] }>('/remittance-requests')
      .then((res) => setRequests(res.remittanceRequests))
      .catch(() => setRequests('error'));
  }

  useEffect(() => {
    void fetchRequests();
  }, []);

  async function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadError(null);
    setUploading(true);
    try {
      const result = await api.upload<{ file: { id: string; filename: string } }>('/files', file);
      setProofFile({ fileId: result.file.id, filename: result.file.filename });
    } catch (err) {
      setUploadError(err instanceof ApiRequestError ? err.message : 'Could not upload the proof photo.');
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      await api.post('/remittance-requests', {
        name: form.name.trim(),
        date: new Date(form.date).toISOString(),
        modeOfPayment: form.modeOfPayment.trim(),
        amount: Number(form.amount),
        referenceNumber: form.referenceNumber.trim(),
        proofFileId: proofFile?.fileId,
      });
      setForm(initialFormState);
      setProofFile(null);
      await fetchRequests();
    } catch (err) {
      setFormError(err instanceof ApiRequestError ? err.message : 'Could not submit the request.');
    } finally {
      setSubmitting(false);
    }
  }

  async function changeStatus(id: string, toStatus: 'VERIFIED' | 'FOR_VERIFICATION') {
    setActionError(null);
    try {
      await api.post(`/remittance-requests/${id}/status`, { toStatus });
      await fetchRequests();
    } catch (err) {
      setActionError(err instanceof ApiRequestError ? err.message : 'Could not update the request.');
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-lg font-semibold">Payment Verification</h1>
        <p className="text-sm text-gray-500">
          Incoming payments for manually-booked guests (bank transfer, GCash, etc.), submitted for the Owner to
          verify.
        </p>
      </div>

      {actionError && (
        <p role="alert" className="text-sm text-red-700">
          {actionError}
        </p>
      )}

      {requests === 'loading' && (
        <table className="w-full text-sm">
          <tbody>
            <SkeletonTableRows rows={4} columns={7} />
          </tbody>
        </table>
      )}
      {requests === 'error' && <p role="alert">Could not load payment verification requests.</p>}
      {Array.isArray(requests) && requests.length === 0 && <EmptyState message="No payment verification requests yet." />}
      {Array.isArray(requests) && requests.length > 0 && (
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-gray-500">
                <th className="py-2 pr-4 font-medium">Reference</th>
                <th className="py-2 pr-4 font-medium">Name</th>
                <th className="py-2 pr-4 font-medium">Date</th>
                <th className="py-2 pr-4 font-medium">Mode</th>
                <th className="py-2 pr-4 font-medium">Amount</th>
                <th className="py-2 pr-4 font-medium">Reference #</th>
                <th className="py-2 pr-4 font-medium">Proof</th>
                <th className="py-2 pr-4 font-medium">Status</th>
                {canVerify && <th className="py-2 font-medium">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {requests.map((req) => (
                <tr key={req.id} className="border-b border-gray-100">
                  <td className="py-2 pr-4 font-medium">{req.referenceNo}</td>
                  <td className="py-2 pr-4">{req.name}</td>
                  <td className="py-2 pr-4">{new Date(req.date).toLocaleDateString()}</td>
                  <td className="py-2 pr-4">{req.modeOfPayment}</td>
                  <td className="py-2 pr-4">{formatPeso(req.amount)}</td>
                  <td className="py-2 pr-4">{req.referenceNumber}</td>
                  <td className="py-2 pr-4">
                    {req.proofFile ? (
                      <a href={req.proofFile.url} target="_blank" rel="noreferrer" className="text-blue-700 hover:underline">
                        View
                      </a>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="py-2 pr-4">
                    <span
                      className={`rounded border px-2 py-0.5 text-xs font-semibold ${REMITTANCE_STATUS_CLASSES[req.status]}`}
                    >
                      {REMITTANCE_STATUS_LABELS[req.status]}
                    </span>
                  </td>
                  {canVerify && (
                    <td className="py-2">
                      {req.status === 'FOR_VERIFICATION' && (
                        <button
                          type="button"
                          onClick={() => void changeStatus(req.id, 'VERIFIED')}
                          className="text-sm text-blue-700 hover:underline"
                        >
                          Mark verified
                        </button>
                      )}
                      {req.status === 'VERIFIED' && (
                        <button
                          type="button"
                          onClick={() => void changeStatus(req.id, 'FOR_VERIFICATION')}
                          className="text-sm text-gray-600 hover:underline"
                        >
                          Revert to for verification
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canCreate && (
        <form
          onSubmit={(e) => void handleCreate(e)}
          className="flex flex-col gap-3 rounded border border-gray-200 p-4"
        >
          <h2 className="text-sm font-semibold">Submit a payment for verification</h2>
          {formError && (
            <p role="alert" className="text-sm text-red-700">
              {formError}
            </p>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm">
              Name
              <input
                required
                className="rounded border border-gray-300 px-2 py-1"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Date
              <input
                required
                type="date"
                className="rounded border border-gray-300 px-2 py-1"
                value={form.date}
                onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Mode of payment
              <input
                required
                placeholder="e.g. GCash, Bank transfer"
                className="rounded border border-gray-300 px-2 py-1"
                value={form.modeOfPayment}
                onChange={(e) => setForm((f) => ({ ...f, modeOfPayment: e.target.value }))}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Amount (₱)
              <input
                required
                type="number"
                min="0.01"
                step="0.01"
                className="rounded border border-gray-300 px-2 py-1"
                value={form.amount}
                onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm sm:col-span-2">
              Reference number
              <input
                required
                className="rounded border border-gray-300 px-2 py-1"
                value={form.referenceNumber}
                onChange={(e) => setForm((f) => ({ ...f, referenceNumber: e.target.value }))}
              />
            </label>
          </div>

          <div className="flex flex-col gap-2 rounded border border-gray-200 bg-gray-50 p-3">
            <p className="text-sm font-medium">Proof / receipt photo (optional)</p>
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,image/heic"
              disabled={uploading}
              onChange={(e) => void handleFileChange(e)}
            />
            {uploading && <p className="text-xs text-gray-500">Uploading…</p>}
            {uploadError && (
              <p role="alert" className="text-xs text-red-600">
                {uploadError}
              </p>
            )}
            {proofFile && (
              <div className="flex items-center justify-between text-xs text-gray-700">
                <span>{proofFile.filename}</span>
                <button type="button" onClick={() => setProofFile(null)} className="text-red-600 hover:underline">
                  Remove
                </button>
              </div>
            )}
          </div>

          <button
            type="submit"
            disabled={submitting || uploading}
            className="w-fit rounded bg-blue-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {submitting ? 'Submitting…' : 'Submit for verification'}
          </button>
        </form>
      )}
    </div>
  );
}
