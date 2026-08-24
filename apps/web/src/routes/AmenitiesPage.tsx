import { AMENITY_CATEGORY_KEYS, type AmenityCategoryKey, type AmenityRequestStatusKey } from '@lwwbr/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '../context/AuthContext.js';
import { AMENITY_REQUEST_STATUS_CLASSES, AMENITY_REQUEST_STATUS_LABELS } from '../lib/amenityRequestStyle.js';
import { api, ApiRequestError } from '../lib/api.js';

interface AmenityItemRow {
  id: string;
  name: string;
  category: AmenityCategoryKey;
  assetTag: string | null;
  totalQty: number;
  condition: string;
  requiresDeposit: boolean;
  depositAmount: number;
  isActive: boolean;
}

interface AmenityRequestRow {
  id: string;
  referenceNo: string;
  qty: number;
  status: AmenityRequestStatusKey;
  dueBackAt: string | null;
  notes: string | null;
  amenityItem: { id: string; name: string; requiresDeposit: boolean; depositAmount: number };
  requestedBy: { fullName: string };
}

const CATEGORY_LABELS: Record<AmenityCategoryKey, string> = {
  CONSOLE: 'Game console',
  VIDEOKE: 'Videoke',
  BOARD_GAME: 'Board game',
  OUTDOOR: 'Outdoor equipment',
  OTHER: 'Other',
};

function formatPeso(amount: number): string {
  return `₱${amount.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Amenity catalogue and request/issue/return workflow — spec §6/§7.4,
// §8.2's amenity module. `requiresDeposit`/`depositAmount` and the
// issue-time `depositCollected` confirmation are informational only — how
// much staff should physically collect, and a checkbox that they did —
// never wired to any Payment/Folio tracking, per the client's
// "monitoring, not transactions" scope decision carried over from M4.
export function AmenitiesPage() {
  const { user } = useAuth();
  const canManage = Boolean(user?.permissions['amenity:manage']);
  const canRequest = Boolean(user?.permissions['amenity:request']);
  const canApprove = Boolean(user?.permissions['amenity:approve']);
  const canIssue = Boolean(user?.permissions['amenity:issue']);
  const canReturn = Boolean(user?.permissions['amenity:return']);

  const [items, setItems] = useState<AmenityItemRow[] | 'loading' | 'error'>('loading');
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [name, setName] = useState('');
  const [category, setCategory] = useState<AmenityCategoryKey>('OTHER');
  const [assetTag, setAssetTag] = useState('');
  const [totalQty, setTotalQty] = useState('1');
  const [condition, setCondition] = useState('Good');
  const [requiresDeposit, setRequiresDeposit] = useState(false);
  const [depositAmount, setDepositAmount] = useState('0');

  const fetchItems = () => {
    setItems('loading');
    return api
      .get<{ amenityItems: AmenityItemRow[] }>('/amenity-items')
      .then((res) => setItems(res.amenityItems))
      .catch(() => setItems('error'));
  };

  const [requests, setRequests] = useState<AmenityRequestRow[] | 'loading' | 'error'>('loading');
  const [requestFormError, setRequestFormError] = useState<string | null>(null);
  const [requestItemId, setRequestItemId] = useState('');
  const [requestQty, setRequestQty] = useState('1');
  const [requestNotes, setRequestNotes] = useState('');
  const [requestSubmitting, setRequestSubmitting] = useState(false);

  // Which row currently has an inline sub-form open (Issue needs a
  // due-back date + deposit confirmation; Return/Lost-damaged needs a
  // condition note) — only one at a time, keyed by request id.
  const [actionPanel, setActionPanel] = useState<{ id: string; action: 'issue' | 'return' } | null>(null);
  const [dueBackAt, setDueBackAt] = useState('');
  const [depositCollected, setDepositCollected] = useState(false);
  const [conditionOnReturn, setConditionOnReturn] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);

  const fetchRequests = () => {
    setRequests('loading');
    return api
      .get<{ amenityRequests: AmenityRequestRow[] }>('/amenity-requests')
      .then((res) => setRequests(res.amenityRequests))
      .catch(() => setRequests('error'));
  };

  useEffect(() => {
    void fetchItems();
    void fetchRequests();
  }, []);

  // Same 60s poll fallback as the Command Center — no realtime
  // subscription for amenity requests yet, so this is the only way a
  // second tab's issue/return shows up here without a manual reload.
  useEffect(() => {
    const interval = setInterval(() => void fetchRequests(), 60_000);
    return () => clearInterval(interval);
  }, []);

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      await api.post('/amenity-items', {
        name,
        category,
        assetTag: assetTag.trim() || undefined,
        totalQty: Number(totalQty),
        condition,
        requiresDeposit,
        depositAmount: requiresDeposit ? Number(depositAmount) : 0,
      });
      setName('');
      setAssetTag('');
      setTotalQty('1');
      setCondition('Good');
      setRequiresDeposit(false);
      setDepositAmount('0');
      await fetchItems();
    } catch (err) {
      setFormError(err instanceof ApiRequestError ? err.message : 'Could not add the item.');
    } finally {
      setSubmitting(false);
    }
  };

  const toggleActive = async (item: AmenityItemRow) => {
    await api.patch(`/amenity-items/${item.id}`, { isActive: !item.isActive });
    await fetchItems();
  };

  const handleCreateRequest = async (event: FormEvent) => {
    event.preventDefault();
    setRequestFormError(null);
    setRequestSubmitting(true);
    try {
      await api.post('/amenity-requests', {
        amenityItemId: requestItemId,
        qty: Number(requestQty),
        notes: requestNotes.trim() || undefined,
      });
      setRequestItemId('');
      setRequestQty('1');
      setRequestNotes('');
      await fetchRequests();
    } catch (err) {
      setRequestFormError(err instanceof ApiRequestError ? err.message : 'Could not submit the request.');
    } finally {
      setRequestSubmitting(false);
    }
  };

  const openActionPanel = (id: string, action: 'issue' | 'return') => {
    setActionPanel({ id, action });
    setActionError(null);
    setDueBackAt('');
    setDepositCollected(false);
    setConditionOnReturn('');
  };

  const changeStatus = async (id: string, body: Record<string, unknown>) => {
    setActionError(null);
    try {
      await api.post(`/amenity-requests/${id}/status`, body);
      setActionPanel(null);
      await fetchRequests();
    } catch (err) {
      setActionError(err instanceof ApiRequestError ? err.message : 'Could not update the request.');
    }
  };

  const submitIssue = async (request: AmenityRequestRow) => {
    if (!dueBackAt) {
      setActionError('Set a due-back date/time before issuing.');
      return;
    }
    if (request.amenityItem.requiresDeposit && !depositCollected) {
      setActionError('Confirm the deposit was collected before issuing this item.');
      return;
    }
    await changeStatus(request.id, {
      toStatus: 'ISSUED',
      dueBackAt: new Date(dueBackAt).toISOString(),
      depositCollected,
    });
  };

  const submitReturn = async (request: AmenityRequestRow, toStatus: 'RETURNED' | 'LOST_DAMAGED') => {
    await changeStatus(request.id, { toStatus, conditionOnReturn: conditionOnReturn.trim() || undefined });
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-lg font-semibold">Amenities</h1>
        <p className="text-sm text-gray-500">
          The lendable-equipment catalogue, plus request/approve/issue/return tracking — game consoles, videoke,
          board games, outdoor gear.
        </p>
      </div>

      {items === 'loading' && <p className="text-sm text-gray-500">Loading…</p>}
      {items === 'error' && <p role="alert">Could not load the amenity catalogue.</p>}
      {Array.isArray(items) && items.length === 0 && (
        <p className="text-sm text-gray-500">No amenity items yet.</p>
      )}
      {Array.isArray(items) && items.length > 0 && (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead>
              <tr className="text-left text-xs font-medium uppercase text-gray-500">
                <th className="py-2 pr-4">Name</th>
                <th className="py-2 pr-4">Category</th>
                <th className="py-2 pr-4">Asset tag</th>
                <th className="py-2 pr-4">Qty</th>
                <th className="py-2 pr-4">Condition</th>
                <th className="py-2 pr-4">Deposit</th>
                <th className="py-2 pr-4">Status</th>
                {canManage && <th className="py-2 pr-4" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {items.map((item) => (
                <tr key={item.id} className={item.isActive ? '' : 'text-gray-400'}>
                  <td className="py-2 pr-4 font-medium">{item.name}</td>
                  <td className="py-2 pr-4">{CATEGORY_LABELS[item.category]}</td>
                  <td className="py-2 pr-4">{item.assetTag ?? '—'}</td>
                  <td className="py-2 pr-4">{item.totalQty}</td>
                  <td className="py-2 pr-4">{item.condition}</td>
                  <td className="py-2 pr-4">{item.requiresDeposit ? formatPeso(item.depositAmount) : '—'}</td>
                  <td className="py-2 pr-4">{item.isActive ? 'Active' : 'Inactive'}</td>
                  {canManage && (
                    <td className="py-2 pr-4">
                      <button
                        type="button"
                        onClick={() => void toggleActive(item)}
                        className="text-xs font-medium text-blue-700 hover:underline"
                      >
                        {item.isActive ? 'Deactivate' : 'Reactivate'}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canManage && (
        <form onSubmit={(e) => void handleCreate(e)} className="flex flex-col gap-3 rounded border border-gray-200 p-4">
          <h2 className="text-sm font-semibold text-gray-700">Add an item</h2>
          {formError && <p role="alert" className="text-sm text-red-700">{formError}</p>}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-xs font-medium text-gray-600">
              Name
              <input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="rounded border border-gray-300 px-2 py-1 text-sm"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-gray-600">
              Category
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value as AmenityCategoryKey)}
                className="rounded border border-gray-300 px-2 py-1 text-sm"
              >
                {AMENITY_CATEGORY_KEYS.map((key) => (
                  <option key={key} value={key}>
                    {CATEGORY_LABELS[key]}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-gray-600">
              Asset tag (optional)
              <input
                value={assetTag}
                onChange={(e) => setAssetTag(e.target.value)}
                className="rounded border border-gray-300 px-2 py-1 text-sm"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-gray-600">
              Total quantity
              <input
                required
                type="number"
                min={1}
                value={totalQty}
                onChange={(e) => setTotalQty(e.target.value)}
                className="rounded border border-gray-300 px-2 py-1 text-sm"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-gray-600">
              Condition
              <input
                required
                value={condition}
                onChange={(e) => setCondition(e.target.value)}
                className="rounded border border-gray-300 px-2 py-1 text-sm"
              />
            </label>
            <label className="flex items-center gap-2 text-xs font-medium text-gray-600">
              <input
                type="checkbox"
                checked={requiresDeposit}
                onChange={(e) => setRequiresDeposit(e.target.checked)}
              />
              Requires a deposit
            </label>
            {requiresDeposit && (
              <label className="flex flex-col gap-1 text-xs font-medium text-gray-600">
                Deposit amount (₱, informational only)
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={depositAmount}
                  onChange={(e) => setDepositAmount(e.target.value)}
                  className="rounded border border-gray-300 px-2 py-1 text-sm"
                />
              </label>
            )}
          </div>
          <button
            type="submit"
            disabled={submitting}
            className="w-fit rounded bg-blue-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {submitting ? 'Adding…' : 'Add item'}
          </button>
        </form>
      )}

      <div className="border-t border-gray-200 pt-6">
        <h2 className="mb-2 text-sm font-semibold text-gray-700">Requests</h2>

        {requests === 'loading' && <p className="text-sm text-gray-500">Loading…</p>}
        {requests === 'error' && <p role="alert">Could not load amenity requests.</p>}
        {Array.isArray(requests) && requests.length === 0 && (
          <p className="text-sm text-gray-500">No amenity requests yet.</p>
        )}
        {Array.isArray(requests) && requests.length > 0 && (
          <ul className="flex flex-col gap-2">
            {requests.map((req) => (
              <li key={req.id} className="rounded border border-gray-200 p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <span className="font-medium">{req.referenceNo}</span> — {req.amenityItem.name} x{req.qty}
                    <span className="ml-2 text-xs text-gray-500">requested by {req.requestedBy.fullName}</span>
                  </div>
                  <span
                    className={`rounded border px-2 py-0.5 text-xs font-semibold ${AMENITY_REQUEST_STATUS_CLASSES[req.status]}`}
                  >
                    {AMENITY_REQUEST_STATUS_LABELS[req.status]}
                  </span>
                </div>
                {req.dueBackAt && (req.status === 'ISSUED' || req.status === 'OVERDUE') && (
                  <p className="mt-1 text-xs text-gray-500">Due back {new Date(req.dueBackAt).toLocaleString()}</p>
                )}
                {req.notes && <p className="mt-1 text-xs text-gray-600">&quot;{req.notes}&quot;</p>}

                <div className="mt-2 flex flex-wrap gap-2">
                  {req.status === 'REQUESTED' && canApprove && (
                    <>
                      <button
                        type="button"
                        onClick={() => void changeStatus(req.id, { toStatus: 'APPROVED' })}
                        className="rounded bg-blue-700 px-3 py-1 text-xs font-medium text-white"
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        onClick={() => void changeStatus(req.id, { toStatus: 'CANCELLED' })}
                        className="rounded border border-gray-300 px-3 py-1 text-xs font-medium text-gray-700"
                      >
                        Cancel
                      </button>
                    </>
                  )}
                  {req.status === 'APPROVED' && canIssue && (
                    <button
                      type="button"
                      onClick={() => openActionPanel(req.id, 'issue')}
                      className="rounded bg-blue-700 px-3 py-1 text-xs font-medium text-white"
                    >
                      Issue
                    </button>
                  )}
                  {req.status === 'APPROVED' && canApprove && (
                    <button
                      type="button"
                      onClick={() => void changeStatus(req.id, { toStatus: 'CANCELLED' })}
                      className="rounded border border-gray-300 px-3 py-1 text-xs font-medium text-gray-700"
                    >
                      Cancel
                    </button>
                  )}
                  {(req.status === 'ISSUED' || req.status === 'OVERDUE') && canReturn && (
                    <button
                      type="button"
                      onClick={() => openActionPanel(req.id, 'return')}
                      className="rounded bg-blue-700 px-3 py-1 text-xs font-medium text-white"
                    >
                      Return
                    </button>
                  )}
                </div>

                {actionPanel?.id === req.id && actionPanel.action === 'issue' && (
                  <div className="mt-3 flex flex-col gap-2 rounded border border-gray-200 bg-gray-50 p-3">
                    {actionError && <p role="alert" className="text-xs text-red-700">{actionError}</p>}
                    <label className="flex flex-col gap-1 text-xs font-medium text-gray-600">
                      Due back
                      <input
                        type="datetime-local"
                        value={dueBackAt}
                        onChange={(e) => setDueBackAt(e.target.value)}
                        className="rounded border border-gray-300 px-2 py-1 text-sm"
                      />
                    </label>
                    {req.amenityItem.requiresDeposit && (
                      <label className="flex items-center gap-2 text-xs font-medium text-gray-600">
                        <input
                          type="checkbox"
                          checked={depositCollected}
                          onChange={(e) => setDepositCollected(e.target.checked)}
                        />
                        Deposit collected ({formatPeso(req.amenityItem.depositAmount)}, informational only)
                      </label>
                    )}
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => void submitIssue(req)}
                        className="rounded bg-blue-700 px-3 py-1 text-xs font-medium text-white"
                      >
                        Confirm issue
                      </button>
                      <button
                        type="button"
                        onClick={() => setActionPanel(null)}
                        className="rounded border border-gray-300 px-3 py-1 text-xs font-medium text-gray-700"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {actionPanel?.id === req.id && actionPanel.action === 'return' && (
                  <div className="mt-3 flex flex-col gap-2 rounded border border-gray-200 bg-gray-50 p-3">
                    {actionError && <p role="alert" className="text-xs text-red-700">{actionError}</p>}
                    <label className="flex flex-col gap-1 text-xs font-medium text-gray-600">
                      Condition on return (optional)
                      <input
                        value={conditionOnReturn}
                        onChange={(e) => setConditionOnReturn(e.target.value)}
                        className="rounded border border-gray-300 px-2 py-1 text-sm"
                      />
                    </label>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => void submitReturn(req, 'RETURNED')}
                        className="rounded bg-blue-700 px-3 py-1 text-xs font-medium text-white"
                      >
                        Confirm returned
                      </button>
                      <button
                        type="button"
                        onClick={() => void submitReturn(req, 'LOST_DAMAGED')}
                        className="rounded border border-red-300 px-3 py-1 text-xs font-medium text-red-700"
                      >
                        Mark lost/damaged
                      </button>
                      <button
                        type="button"
                        onClick={() => setActionPanel(null)}
                        className="rounded border border-gray-300 px-3 py-1 text-xs font-medium text-gray-700"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        {canRequest && (
          <form
            onSubmit={(e) => void handleCreateRequest(e)}
            className="mt-4 flex flex-col gap-3 rounded border border-gray-200 p-4"
          >
            <h3 className="text-sm font-semibold text-gray-700">Request an item</h3>
            {requestFormError && <p role="alert" className="text-sm text-red-700">{requestFormError}</p>}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-xs font-medium text-gray-600">
                Item
                <select
                  required
                  value={requestItemId}
                  onChange={(e) => setRequestItemId(e.target.value)}
                  className="rounded border border-gray-300 px-2 py-1 text-sm"
                >
                  <option value="" disabled>
                    Select an item…
                  </option>
                  {Array.isArray(items) &&
                    items
                      .filter((item) => item.isActive)
                      .map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-gray-600">
                Quantity
                <input
                  required
                  type="number"
                  min={1}
                  value={requestQty}
                  onChange={(e) => setRequestQty(e.target.value)}
                  className="rounded border border-gray-300 px-2 py-1 text-sm"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-gray-600 sm:col-span-2">
                Notes (optional)
                <input
                  value={requestNotes}
                  onChange={(e) => setRequestNotes(e.target.value)}
                  className="rounded border border-gray-300 px-2 py-1 text-sm"
                />
              </label>
            </div>
            <button
              type="submit"
              disabled={requestSubmitting}
              className="w-fit rounded bg-blue-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {requestSubmitting ? 'Submitting…' : 'Submit request'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
