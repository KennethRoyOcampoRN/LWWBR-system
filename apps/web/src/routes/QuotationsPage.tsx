import { QUOTATION_STATUS_LABELS } from '@lwwbr/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { EmptyState } from '../components/EmptyState.js';
import { SkeletonTableRows } from '../components/Skeleton.js';
import { useAuth } from '../context/AuthContext.js';
import { api, ApiRequestError } from '../lib/api.js';
import { QUOTATION_STATUS_CLASSES } from '../lib/quotationStyle.js';

interface QuotationRequestRow {
  id: string;
  referenceNo: string;
  name: string;
  contactNumber: string;
  email: string;
  pax: number;
  checkInDate: string;
  checkOutDate: string;
  note: string | null;
  status: 'PENDING' | 'DONE';
  createdBy: { fullName: string };
}

const initialFormState = {
  name: '',
  contactNumber: '',
  email: '',
  pax: '',
  checkInDate: '',
  checkOutDate: '',
  note: '',
};

// Spec §11 (client-directed feature, 2026-08-31): a standalone quotation
// request record, no relation to bookings/units/folio. System Admin marks
// it Done or Pending — just those two states, no third option. See
// rolePermissions.ts's own comment for why this is quotation:*, distinct
// from the reserved payment:* namespace.
export function QuotationsPage() {
  const { user } = useAuth();
  const canCreate = Boolean(user?.permissions['quotation:create']);
  const canUpdateStatus = Boolean(user?.permissions['quotation:update_status']);

  const [requests, setRequests] = useState<QuotationRequestRow[] | 'loading' | 'error'>('loading');
  const [form, setForm] = useState(initialFormState);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  function fetchRequests() {
    setRequests('loading');
    return api
      .get<{ quotationRequests: QuotationRequestRow[] }>('/quotation-requests')
      .then((res) => setRequests(res.quotationRequests))
      .catch(() => setRequests('error'));
  }

  useEffect(() => {
    void fetchRequests();
  }, []);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      await api.post('/quotation-requests', {
        name: form.name.trim(),
        contactNumber: form.contactNumber.trim(),
        email: form.email.trim(),
        pax: Number(form.pax),
        checkInDate: new Date(form.checkInDate).toISOString(),
        checkOutDate: new Date(form.checkOutDate).toISOString(),
        note: form.note.trim() || undefined,
      });
      setForm(initialFormState);
      await fetchRequests();
    } catch (err) {
      setFormError(err instanceof ApiRequestError ? err.message : 'Could not submit the request.');
    } finally {
      setSubmitting(false);
    }
  }

  async function changeStatus(id: string, toStatus: 'DONE' | 'PENDING') {
    setActionError(null);
    try {
      await api.post(`/quotation-requests/${id}/status`, { toStatus });
      await fetchRequests();
    } catch (err) {
      setActionError(err instanceof ApiRequestError ? err.message : 'Could not update the request.');
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-lg font-semibold">Quotations</h1>
        <p className="text-sm text-gray-500">Standalone quotation requests — no relation to bookings or units.</p>
      </div>

      {actionError && (
        <p role="alert" className="text-sm text-red-700">
          {actionError}
        </p>
      )}

      {requests === 'loading' && (
        <table className="w-full text-sm">
          <tbody>
            <SkeletonTableRows rows={4} columns={8} />
          </tbody>
        </table>
      )}
      {requests === 'error' && <p role="alert">Could not load quotation requests.</p>}
      {Array.isArray(requests) && requests.length === 0 && <EmptyState message="No quotation requests yet." />}
      {Array.isArray(requests) && requests.length > 0 && (
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-gray-500">
                <th className="py-2 pr-4 font-medium">Reference</th>
                <th className="py-2 pr-4 font-medium">Name</th>
                <th className="py-2 pr-4 font-medium">Contact</th>
                <th className="py-2 pr-4 font-medium">Email</th>
                <th className="py-2 pr-4 font-medium">Pax</th>
                <th className="py-2 pr-4 font-medium">Check-in</th>
                <th className="py-2 pr-4 font-medium">Check-out</th>
                <th className="py-2 pr-4 font-medium">Status</th>
                {canUpdateStatus && <th className="py-2 font-medium">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {requests.map((req) => (
                <tr key={req.id} className="border-b border-gray-100">
                  <td className="py-2 pr-4 font-medium">{req.referenceNo}</td>
                  <td className="py-2 pr-4">{req.name}</td>
                  <td className="py-2 pr-4">{req.contactNumber}</td>
                  <td className="py-2 pr-4">{req.email}</td>
                  <td className="py-2 pr-4">{req.pax}</td>
                  <td className="py-2 pr-4">{new Date(req.checkInDate).toLocaleDateString()}</td>
                  <td className="py-2 pr-4">{new Date(req.checkOutDate).toLocaleDateString()}</td>
                  <td className="py-2 pr-4">
                    <span
                      className={`rounded border px-2 py-0.5 text-xs font-semibold ${QUOTATION_STATUS_CLASSES[req.status]}`}
                    >
                      {QUOTATION_STATUS_LABELS[req.status]}
                    </span>
                  </td>
                  {canUpdateStatus && (
                    <td className="py-2">
                      {req.status === 'PENDING' && (
                        <button
                          type="button"
                          onClick={() => void changeStatus(req.id, 'DONE')}
                          className="text-sm text-blue-700 hover:underline"
                        >
                          Mark done
                        </button>
                      )}
                      {req.status === 'DONE' && (
                        <button
                          type="button"
                          onClick={() => void changeStatus(req.id, 'PENDING')}
                          className="text-sm text-gray-600 hover:underline"
                        >
                          Revert to pending
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
          <h2 className="text-sm font-semibold">Submit a quotation request</h2>
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
              Contact number
              <input
                required
                className="rounded border border-gray-300 px-2 py-1"
                value={form.contactNumber}
                onChange={(e) => setForm((f) => ({ ...f, contactNumber: e.target.value }))}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Email
              <input
                required
                type="email"
                className="rounded border border-gray-300 px-2 py-1"
                value={form.email}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Pax
              <input
                required
                type="number"
                min="1"
                step="1"
                className="rounded border border-gray-300 px-2 py-1"
                value={form.pax}
                onChange={(e) => setForm((f) => ({ ...f, pax: e.target.value }))}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Check-in date
              <input
                required
                type="date"
                className="rounded border border-gray-300 px-2 py-1"
                value={form.checkInDate}
                onChange={(e) => setForm((f) => ({ ...f, checkInDate: e.target.value }))}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Check-out date
              <input
                required
                type="date"
                className="rounded border border-gray-300 px-2 py-1"
                value={form.checkOutDate}
                onChange={(e) => setForm((f) => ({ ...f, checkOutDate: e.target.value }))}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm sm:col-span-2">
              Note
              <textarea
                className="rounded border border-gray-300 px-2 py-1"
                rows={3}
                value={form.note}
                onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
              />
            </label>
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="w-fit rounded bg-blue-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {submitting ? 'Submitting…' : 'Submit request'}
          </button>
        </form>
      )}
    </div>
  );
}
