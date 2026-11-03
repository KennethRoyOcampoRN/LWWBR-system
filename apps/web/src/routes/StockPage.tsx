import {
  STOCK_CATEGORY_KEYS,
  STOCK_CATEGORY_LABELS,
  STOCK_MOVEMENT_REASON_KEYS,
  STOCK_MOVEMENT_REASON_LABELS,
  type StockCategoryKey,
  type StockMovementReasonKey,
} from '@lwwbr/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '../components/Button.js';
import { Card, Section } from '../components/Card.js';
import { DataTable, type DataTableColumn } from '../components/DataTable.js';
import { Field, INPUT_CLASSES } from '../components/Field.js';
import { PageHeader } from '../components/PageHeader.js';
import { StatusBadge } from '../components/StatusBadge.js';
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
//
// Visual redesign, step 1 (client-directed, 2026-11-xx): reference
// conversion to the new primitive set (PageHeader, Section/Card,
// DataTable, StatusBadge, Button, Field) — the page the client reviews
// before the remaining eight hand-rolled tables convert the same way.
// The hand-rolled `<table>` this used to render is now one DataTable
// call; the page's own logic (fetch, create, toggle, delete, log
// movement) is unchanged. A per-row conditional style (the low-qty
// amber highlight) lives inside that column's own `render`, not on
// DataTable's `className` — that field is for static per-column
// styling, since it isn't given the row. Density follow-up, same
// slice: the page description used to be a full sentence under the
// title ("Stock monitoring and purchasing, in and out only — no
// approval workflow.") — shortened to match PageHeader's one-line
// intent, which is also where the explanation this used to carry lives
// now (hint text on the Add-item form below, where it's actually
// relevant to the decision being made).
export function StockPage() {
  const { user } = useAuth();
  const canManage = Boolean(user?.permissions['stock:manage']);
  const canLogMovement = Boolean(user?.permissions['stock:log_movement']);
  const hasActionsColumn = canLogMovement || canManage;

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

  // Client-directed feature, 2026-09-11: a genuine soft-delete
  // (deletedAt) — see stock/service.ts's deleteStockItem for why this
  // isn't the same hard-delete pattern FnbPage.tsx's menu items use.
  // Same confirm-dialog and error-surfacing shape as that page's own
  // deleteItem, reused deliberately rather than inventing a new one.
  const [deleteError, setDeleteError] = useState<string | null>(null);
  async function deleteItem(item: StockItemRow) {
    if (!window.confirm(`Delete "${item.name}"? This removes it from the catalog.`)) return;
    setDeleteError(null);
    try {
      await api.delete(`/stock-items/${item.id}`);
      await fetchItems();
    } catch (err) {
      setDeleteError(err instanceof ApiRequestError ? err.message : 'Could not delete the item.');
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

  function renderActions(item: StockItemRow) {
    if (!hasActionsColumn) return null;
    return (
      <>
        {canLogMovement && item.isActive && (
          <Button
            variant="secondary"
            onClick={() => {
              setMovementItemId(item.id);
              setMovementForm(initialMovementForm);
              setMovementError(null);
            }}
          >
            Log movement
          </Button>
        )}
        {canManage && (
          <Button variant="secondary" onClick={() => void toggleActive(item)}>
            {item.isActive ? 'Deactivate' : 'Reactivate'}
          </Button>
        )}
        {/* Client decision, 2026-09-11, same "Option B" convention as
            Amenities/F&B: only offered once the item is already
            inactive — matches the server's own 409 ITEM_STILL_ACTIVE
            guard. */}
        {canManage && !item.isActive && (
          <Button variant="danger" onClick={() => void deleteItem(item)}>
            Delete
          </Button>
        )}
      </>
    );
  }

  const columns: DataTableColumn<StockItemRow>[] = [
    { key: 'name', header: 'Name', render: (item) => item.name },
    { key: 'category', header: 'Category', render: (item) => STOCK_CATEGORY_LABELS[item.category] },
    { key: 'unit', header: 'Unit', render: (item) => item.unitOfMeasure },
    {
      key: 'qty',
      header: 'Current qty',
      render: (item) => (
        <span className={item.currentQty < item.reorderLevel ? 'font-semibold text-amber-700' : ''}>
          {item.currentQty}
        </span>
      ),
    },
    { key: 'reorder', header: 'Reorder at', render: (item) => item.reorderLevel },
    {
      key: 'status',
      header: 'Status',
      render: (item) => (
        <StatusBadge variant={item.isActive ? 'success' : 'neutral'}>
          {item.isActive ? 'Active' : 'Inactive'}
        </StatusBadge>
      ),
    },
    ...(hasActionsColumn
      ? [{ key: 'actions', header: 'Actions', render: renderActions, hideOnMobile: true } satisfies DataTableColumn<StockItemRow>]
      : []),
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Stock" description="Stock monitoring and purchasing, in and out only." />

      {deleteError && (
        <p role="alert" className="text-sm font-medium text-danger-600">
          {deleteError}
        </p>
      )}

      <Section title="Catalog">
        <DataTable
          columns={columns}
          rows={items}
          rowKey={(item) => item.id}
          emptyMessage="No stock items yet."
          errorMessage="Could not load the stock catalog."
          loadingRows={4}
          renderMobileActions={hasActionsColumn ? renderActions : undefined}
        />
      </Section>

      {movementItemId && (
        <Card>
          <form
            aria-label="Log movement"
            onSubmit={(e) => void handleLogMovement(e)}
            className="flex flex-col gap-3"
          >
            <h2 className="text-sm font-semibold text-ink">
              Log movement — {items !== 'loading' && items !== 'error' && items.find((i) => i.id === movementItemId)?.name}
            </h2>
            {movementError && (
              <p role="alert" className="text-sm font-medium text-danger-600">
                {movementError}
              </p>
            )}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label="Reason">
                <select
                  className={INPUT_CLASSES}
                  value={movementForm.reason}
                  onChange={(e) => setMovementForm((f) => ({ ...f, reason: e.target.value as StockMovementReasonKey }))}
                >
                  {STOCK_MOVEMENT_REASON_KEYS.map((key) => (
                    <option key={key} value={key}>
                      {STOCK_MOVEMENT_REASON_LABELS[key]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={movementForm.reason === 'ADJUST' ? 'Signed correction (+/-)' : 'Quantity'}>
                <input
                  required
                  type="number"
                  step="0.01"
                  className={INPUT_CLASSES}
                  value={movementForm.quantity}
                  onChange={(e) => setMovementForm((f) => ({ ...f, quantity: e.target.value }))}
                />
              </Field>
              <div className="sm:col-span-3">
                <Field label="Note (optional)">
                  <input
                    className={INPUT_CLASSES}
                    value={movementForm.note}
                    onChange={(e) => setMovementForm((f) => ({ ...f, note: e.target.value }))}
                  />
                </Field>
              </div>
            </div>
            <div className="flex gap-3">
              <Button type="submit" disabled={movementSubmitting}>
                {movementSubmitting ? 'Logging…' : 'Log movement'}
              </Button>
              <Button type="button" variant="secondary" onClick={() => setMovementItemId(null)}>
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      )}

      {canManage && (
        <Section title="Add an item">
          <form aria-label="Add an item" onSubmit={(e) => void handleCreateItem(e)} className="flex flex-col gap-3">
            {catalogError && (
              <p role="alert" className="text-sm font-medium text-danger-600">
                {catalogError}
              </p>
            )}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Name">
                <input
                  required
                  className={INPUT_CLASSES}
                  value={catalogForm.name}
                  onChange={(e) => setCatalogForm((f) => ({ ...f, name: e.target.value }))}
                />
              </Field>
              <Field label="Category">
                <select
                  className={INPUT_CLASSES}
                  value={catalogForm.category}
                  onChange={(e) => setCatalogForm((f) => ({ ...f, category: e.target.value as StockCategoryKey }))}
                >
                  {STOCK_CATEGORY_KEYS.map((key) => (
                    <option key={key} value={key}>
                      {STOCK_CATEGORY_LABELS[key]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Unit of measure" hint="e.g. pack, bottle, pcs">
                <input
                  required
                  className={INPUT_CLASSES}
                  value={catalogForm.unitOfMeasure}
                  onChange={(e) => setCatalogForm((f) => ({ ...f, unitOfMeasure: e.target.value }))}
                />
              </Field>
              <Field label="Reorder threshold">
                <input
                  required
                  type="number"
                  min="0"
                  step="0.01"
                  className={INPUT_CLASSES}
                  value={catalogForm.reorderLevel}
                  onChange={(e) => setCatalogForm((f) => ({ ...f, reorderLevel: e.target.value }))}
                />
              </Field>
              <Field label="Starting quantity (optional)">
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="0"
                  className={INPUT_CLASSES}
                  value={catalogForm.initialQty}
                  onChange={(e) => setCatalogForm((f) => ({ ...f, initialQty: e.target.value }))}
                />
              </Field>
            </div>
            <Button type="submit" disabled={catalogSubmitting}>
              {catalogSubmitting ? 'Adding…' : 'Add item'}
            </Button>
          </form>
        </Section>
      )}
    </div>
  );
}
