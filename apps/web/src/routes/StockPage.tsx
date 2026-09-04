import {
  STOCK_CATEGORY_KEYS,
  STOCK_CATEGORY_LABELS,
  STOCK_MOVEMENT_REASON_KEYS,
  STOCK_MOVEMENT_REASON_LABELS,
  type StockCategoryKey,
  type StockMovementReasonKey,
} from '@lwwbr/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { EmptyState } from '../components/EmptyState.js';
import { SkeletonTableRows } from '../components/Skeleton.js';
import { useAuth } from '../context/AuthContext.js';
import { api, ApiRequestError } from '../lib/api.js';

interface StockItemRow {
  id: string;
  name: string;
  category: StockCategoryKey;
  unitOfMeasure: string;
  currentQty: number;
  reorderLevel: number;
  isActive: boolean;
}

const initialCatalogForm = {
  name: '',
  category: 'OTHER' as StockCategoryKey,
  unitOfMeasure: '',
  reorderLevel: '',
  initialQty: '',
};

const initialMovementForm = {
  reason: 'RECEIVE' as StockMovementReasonKey,
  quantity: '',
  note: '',
};

// Client-directed feature, 2026-08-31: stock monitoring and purchasing,
// in/out only — no StockRequest approval workflow. See stock/service.ts's
// own comments for why this is stock:*, not inventory:* (reserved for
// that unbuilt workflow), and why currentQty is never directly editable
// here — only movements can change it.
export function StockPage() {
  const { user } = useAuth();
  const canManage = Boolean(user?.permissions['stock:manage']);
  const canLogMovement = Boolean(user?.permissions['stock:log_movement']);

  const [items, setItems] = useState<StockItemRow[] | 'loading' | 'error'>('loading');
  const [catalogForm, setCatalogForm] = useState(initialCatalogForm);
  const [catalogSubmitting, setCatalogSubmitting] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  const [movementItemId, setMovementItemId] = useState<string | null>(null);
  const [movementForm, setMovementForm] = useState(initialMovementForm);
  const [movementSubmitting, setMovementSubmitting] = useState(false);
  const [movementError, setMovementError] = useState<string | null>(null);

  function fetchItems() {
    setItems('loading');
    return api
      .get<{ stockItems: StockItemRow[] }>('/stock-items')
      .then((res) => setItems(res.stockItems))
      .catch(() => setItems('error'));
  }

  useEffect(() => {
    void fetchItems();
  }, []);

  async function handleCreateItem(e: FormEvent) {
    e.preventDefault();
    setCatalogError(null);
    setCatalogSubmitting(true);
    try {
      await api.post('/stock-items', {
        name: catalogForm.name.trim(),
        category: catalogForm.category,
        unitOfMeasure: catalogForm.unitOfMeasure.trim(),
        reorderLevel: Number(catalogForm.reorderLevel),
        initialQty: catalogForm.initialQty === '' ? undefined : Number(catalogForm.initialQty),
      });
      setCatalogForm(initialCatalogForm);
      await fetchItems();
    } catch (err) {
      setCatalogError(err instanceof ApiRequestError ? err.message : 'Could not add the item.');
    } finally {
      setCatalogSubmitting(false);
    }
  }

  async function toggleActive(item: StockItemRow) {
    try {
      await api.patch(`/stock-items/${item.id}`, { isActive: !item.isActive });
      await fetchItems();
    } catch {
      // Surfaced via the catalog reload failing silently is acceptable
      // here — this is a low-stakes toggle, not a form submission with
      // its own error slot.
    }
  }

  async function handleLogMovement(e: FormEvent) {
    e.preventDefault();
    if (!movementItemId) return;
    setMovementError(null);
    setMovementSubmitting(true);
    try {
      await api.post(`/stock-items/${movementItemId}/movements`, {
        reason: movementForm.reason,
        quantity: Number(movementForm.quantity),
        note: movementForm.note.trim() || undefined,
      });
      setMovementItemId(null);
      setMovementForm(initialMovementForm);
      await fetchItems();
    } catch (err) {
      setMovementError(err instanceof ApiRequestError ? err.message : 'Could not log the movement.');
    } finally {
      setMovementSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-lg font-semibold">Stock</h1>
        <p className="text-sm text-gray-500">
          Stock monitoring and purchasing, in and out only — no approval workflow.
        </p>
      </div>

      {items === 'loading' && (
        <table className="w-full text-sm">
          <tbody>
            <SkeletonTableRows rows={4} columns={6} />
          </tbody>
        </table>
      )}
      {items === 'error' && <p role="alert">Could not load the stock catalog.</p>}
      {Array.isArray(items) && items.length === 0 && <EmptyState message="No stock items yet." />}
      {Array.isArray(items) && items.length > 0 && (
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-gray-500">
                <th className="py-2 pr-4 font-medium">Name</th>
                <th className="py-2 pr-4 font-medium">Category</th>
                <th className="py-2 pr-4 font-medium">Unit</th>
                <th className="py-2 pr-4 font-medium">Current qty</th>
                <th className="py-2 pr-4 font-medium">Reorder at</th>
                <th className="py-2 pr-4 font-medium">Status</th>
                {(canLogMovement || canManage) && <th className="py-2 font-medium">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="border-b border-gray-100">
                  <td className="py-2 pr-4 font-medium">{item.name}</td>
                  <td className="py-2 pr-4">{STOCK_CATEGORY_LABELS[item.category]}</td>
                  <td className="py-2 pr-4">{item.unitOfMeasure}</td>
                  <td className={`py-2 pr-4 ${item.currentQty < item.reorderLevel ? 'font-semibold text-amber-700' : ''}`}>
                    {item.currentQty}
                  </td>
                  <td className="py-2 pr-4">{item.reorderLevel}</td>
                  <td className="py-2 pr-4">{item.isActive ? 'Active' : 'Inactive'}</td>
                  {(canLogMovement || canManage) && (
                    <td className="py-2 flex gap-3">
                      {canLogMovement && item.isActive && (
                        <button
                          type="button"
                          onClick={() => {
                            setMovementItemId(item.id);
                            setMovementForm(initialMovementForm);
                            setMovementError(null);
                          }}
                          className="text-sm text-blue-700 hover:underline"
                        >
                          Log movement
                        </button>
                      )}
                      {canManage && (
                        <button
                          type="button"
                          onClick={() => void toggleActive(item)}
                          className="text-sm text-gray-600 hover:underline"
                        >
                          {item.isActive ? 'Deactivate' : 'Reactivate'}
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

      {movementItemId && (
        <form
          onSubmit={(e) => void handleLogMovement(e)}
          className="flex flex-col gap-3 rounded border border-gray-200 p-4"
        >
          <h2 className="text-sm font-semibold">
            Log movement — {items !== 'loading' && items !== 'error' && items.find((i) => i.id === movementItemId)?.name}
          </h2>
          {movementError && (
            <p role="alert" className="text-sm text-red-700">
              {movementError}
            </p>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <label className="flex flex-col gap-1 text-sm">
              Reason
              <select
                className="rounded border border-gray-300 px-2 py-1"
                value={movementForm.reason}
                onChange={(e) => setMovementForm((f) => ({ ...f, reason: e.target.value as StockMovementReasonKey }))}
              >
                {STOCK_MOVEMENT_REASON_KEYS.map((key) => (
                  <option key={key} value={key}>
                    {STOCK_MOVEMENT_REASON_LABELS[key]}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              {movementForm.reason === 'ADJUST' ? 'Signed correction (+/-)' : 'Quantity'}
              <input
                required
                type="number"
                step="0.01"
                className="rounded border border-gray-300 px-2 py-1"
                value={movementForm.quantity}
                onChange={(e) => setMovementForm((f) => ({ ...f, quantity: e.target.value }))}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm sm:col-span-3">
              Note (optional)
              <input
                className="rounded border border-gray-300 px-2 py-1"
                value={movementForm.note}
                onChange={(e) => setMovementForm((f) => ({ ...f, note: e.target.value }))}
              />
            </label>
          </div>
          <div className="flex gap-3">
            <button
              type="submit"
              disabled={movementSubmitting}
              className="w-fit rounded bg-blue-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {movementSubmitting ? 'Logging…' : 'Log movement'}
            </button>
            <button
              type="button"
              onClick={() => setMovementItemId(null)}
              className="w-fit rounded px-4 py-2 text-sm font-medium text-gray-600 hover:underline"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {canManage && (
        <form
          onSubmit={(e) => void handleCreateItem(e)}
          className="flex flex-col gap-3 rounded border border-gray-200 p-4"
        >
          <h2 className="text-sm font-semibold">Add an item</h2>
          {catalogError && (
            <p role="alert" className="text-sm text-red-700">
              {catalogError}
            </p>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm">
              Name
              <input
                required
                className="rounded border border-gray-300 px-2 py-1"
                value={catalogForm.name}
                onChange={(e) => setCatalogForm((f) => ({ ...f, name: e.target.value }))}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Category
              <select
                className="rounded border border-gray-300 px-2 py-1"
                value={catalogForm.category}
                onChange={(e) => setCatalogForm((f) => ({ ...f, category: e.target.value as StockCategoryKey }))}
              >
                {STOCK_CATEGORY_KEYS.map((key) => (
                  <option key={key} value={key}>
                    {STOCK_CATEGORY_LABELS[key]}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Unit of measure
              <input
                required
                placeholder="e.g. pack, bottle, pcs"
                className="rounded border border-gray-300 px-2 py-1"
                value={catalogForm.unitOfMeasure}
                onChange={(e) => setCatalogForm((f) => ({ ...f, unitOfMeasure: e.target.value }))}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Reorder threshold
              <input
                required
                type="number"
                min="0"
                step="0.01"
                className="rounded border border-gray-300 px-2 py-1"
                value={catalogForm.reorderLevel}
                onChange={(e) => setCatalogForm((f) => ({ ...f, reorderLevel: e.target.value }))}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Starting quantity (optional)
              <input
                type="number"
                min="0"
                step="0.01"
                placeholder="0"
                className="rounded border border-gray-300 px-2 py-1"
                value={catalogForm.initialQty}
                onChange={(e) => setCatalogForm((f) => ({ ...f, initialQty: e.target.value }))}
              />
            </label>
          </div>
          <button
            type="submit"
            disabled={catalogSubmitting}
            className="w-fit rounded bg-blue-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {catalogSubmitting ? 'Adding…' : 'Add item'}
          </button>
        </form>
      )}
    </div>
  );
}
