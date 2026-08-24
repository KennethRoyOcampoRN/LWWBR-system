import { AMENITY_CATEGORY_KEYS, type AmenityCategoryKey } from '@lwwbr/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '../context/AuthContext.js';
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

// Amenity catalogue — spec §6 AmenityItem, §8.2's amenity module. First
// M5 slice: the catalogue only (request → issue → return is a separate,
// later slice). `requiresDeposit`/`depositAmount` are shown as
// informational fields only — how much staff should physically collect —
// not wired to any Payment/Folio tracking, per the client's "monitoring,
// not transactions" scope decision carried over from M4.
export function AmenitiesPage() {
  const { user } = useAuth();
  const canManage = Boolean(user?.permissions['amenity:manage']);

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

  useEffect(() => {
    void fetchItems();
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

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-lg font-semibold">Amenities</h1>
        <p className="text-sm text-gray-500">
          The lendable-equipment catalogue — game consoles, videoke, board games, outdoor gear. Request/issue/return
          is a separate step, not built yet.
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
    </div>
  );
}
