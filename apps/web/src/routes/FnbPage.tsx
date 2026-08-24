import {
  FNB_ORDER_AMBER_MINUTES,
  FNB_ORDER_RED_MINUTES,
  FNB_ORDER_TYPE_KEYS,
  FNB_SETTLEMENT_KEYS,
  type FnbOrderStatusKey,
  type FnbOrderTypeKey,
  type FnbSettlementKey,
} from '@lwwbr/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '../context/AuthContext.js';
import { api, ApiRequestError } from '../lib/api.js';
import { FNB_ORDER_STATUS_LABELS, FNB_ORDER_TYPE_LABELS } from '../lib/fnbOrderStyle.js';
import { subscribeToFnbOrderChanges } from '../lib/realtime.js';

interface MenuItemRow {
  id: string;
  name: string;
  category: string;
  price: number;
  isAvailable: boolean;
  prepMinutes: number | null;
  sortOrder: number;
}

interface OrderLineRow {
  id: string;
  menuItemId: string;
  qty: number;
  unitPrice: number;
  notes: string | null;
  menuItem: { id: string; name: string };
}

interface FnbOrderRow {
  id: string;
  referenceNo: string;
  unit: { id: string; code: string; name: string } | null;
  guestName: string | null;
  type: FnbOrderTypeKey;
  scheduledFor: string | null;
  settlement: FnbSettlementKey;
  status: FnbOrderStatusKey;
  subtotal: number;
  notes: string | null;
  createdAt: string;
  createdBy: { fullName: string };
  lines: OrderLineRow[];
}

interface OrderableUnit {
  id: string;
  code: string;
  name: string;
  status: string;
}

interface DraftLine {
  menuItemId: string;
  qty: string;
}

const BOARD_COLUMNS: FnbOrderStatusKey[] = ['RECEIVED', 'PREPARING', 'READY'];

function formatPeso(amount: number): string {
  return `₱${amount.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function minutesSince(dateStr: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(dateStr).getTime()) / 60_000));
}

function timerClass(minutes: number): string {
  if (minutes >= FNB_ORDER_RED_MINUTES) return 'border-red-400 bg-red-50 text-red-900';
  if (minutes >= FNB_ORDER_AMBER_MINUTES) return 'border-amber-400 bg-amber-50 text-amber-900';
  return 'border-gray-200 bg-white text-gray-900';
}

// Restaurant menu + order/kitchen board — spec §6/§7.3, §8.2's F&B
// module. `settlement` (PAY_NOW/CHARGE_TO_ROOM) is an informational
// classification only — client decision, 2026-08-24, extending M4's
// monitoring-not-transactions scope to F&B — never wired to any Payment/
// FolioCharge tracking. `category` stays free text, unlike AmenityItem's
// closed enum, matching spec's own data model.
export function FnbPage() {
  const { user } = useAuth();
  const canManageMenu = Boolean(user?.permissions['fnb:manage_menu']);
  const canCreateOrder = Boolean(user?.permissions['fnb:create']);
  const canUpdateOrderStatus = Boolean(user?.permissions['fnb:update_status']);

  const [items, setItems] = useState<MenuItemRow[] | 'loading' | 'error'>('loading');
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [price, setPrice] = useState('0');
  const [prepMinutes, setPrepMinutes] = useState('');

  const fetchItems = () => {
    setItems('loading');
    return api
      .get<{ menuItems: MenuItemRow[] }>('/menu-items')
      .then((res) => setItems(res.menuItems))
      .catch(() => setItems('error'));
  };

  const [orders, setOrders] = useState<FnbOrderRow[] | 'loading' | 'error'>('loading');
  const [units, setUnits] = useState<OrderableUnit[]>([]);
  const [orderType, setOrderType] = useState<FnbOrderTypeKey>('DINE_IN');
  const [settlement, setSettlement] = useState<FnbSettlementKey>('PAY_NOW');
  const [unitId, setUnitId] = useState('');
  const [guestName, setGuestName] = useState('');
  const [scheduledFor, setScheduledFor] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([{ menuItemId: '', qty: '1' }]);
  const [orderFormError, setOrderFormError] = useState<string | null>(null);
  const [orderSubmitting, setOrderSubmitting] = useState(false);

  const fetchOrders = () => {
    setOrders('loading');
    return api
      .get<{ fnbOrders: FnbOrderRow[] }>('/fnb-orders?boardOnly=true')
      .then((res) => setOrders(res.fnbOrders))
      .catch(() => setOrders('error'));
  };

  useEffect(() => {
    void fetchItems();
    void fetchOrders();
    if (canCreateOrder) {
      api
        .get<{ units: OrderableUnit[] }>('/units/orderable')
        .then((res) => setUnits(res.units))
        .catch(() => setUnits([]));
    }
  }, [canCreateOrder]);

  // Same fallback principle as the Command Center's 60s poll — halved
  // here since a stale kitchen board is more operationally costly than a
  // stale KPI strip.
  useEffect(() => {
    const interval = setInterval(() => void fetchOrders(), 30_000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeToFnbOrderChanges(() => void fetchOrders(), () => {});
    return unsubscribe;
  }, []);

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      await api.post('/menu-items', {
        name,
        category,
        price: Number(price),
        prepMinutes: prepMinutes ? Number(prepMinutes) : undefined,
      });
      setName('');
      setCategory('');
      setPrice('0');
      setPrepMinutes('');
      await fetchItems();
    } catch (err) {
      setFormError(err instanceof ApiRequestError ? err.message : 'Could not add the menu item.');
    } finally {
      setSubmitting(false);
    }
  };

  const toggleAvailable = async (item: MenuItemRow) => {
    await api.patch(`/menu-items/${item.id}`, { isAvailable: !item.isAvailable });
    await fetchItems();
  };

  const addLine = () => setLines((prev) => [...prev, { menuItemId: '', qty: '1' }]);
  const removeLine = (index: number) => setLines((prev) => prev.filter((_, i) => i !== index));
  const updateLine = (index: number, patch: Partial<DraftLine>) =>
    setLines((prev) => prev.map((line, i) => (i === index ? { ...line, ...patch } : line)));

  const availableMenuItems = Array.isArray(items) ? items.filter((item) => item.isAvailable) : [];
  const subtotalPreview = lines.reduce((sum, line) => {
    const menuItem = availableMenuItems.find((item) => item.id === line.menuItemId);
    return sum + (menuItem ? menuItem.price * (Number(line.qty) || 0) : 0);
  }, 0);

  const handleCreateOrder = async (event: FormEvent) => {
    event.preventDefault();
    setOrderFormError(null);
    setOrderSubmitting(true);
    try {
      await api.post('/fnb-orders', {
        type: orderType,
        settlement,
        unitId: unitId || undefined,
        guestName: guestName.trim() || undefined,
        scheduledFor: orderType === 'ADVANCE_ORDER' && scheduledFor ? new Date(scheduledFor).toISOString() : undefined,
        lines: lines.filter((line) => line.menuItemId).map((line) => ({ menuItemId: line.menuItemId, qty: Number(line.qty) })),
      });
      setOrderType('DINE_IN');
      setSettlement('PAY_NOW');
      setUnitId('');
      setGuestName('');
      setScheduledFor('');
      setLines([{ menuItemId: '', qty: '1' }]);
      await fetchOrders();
    } catch (err) {
      setOrderFormError(err instanceof ApiRequestError ? err.message : 'Could not place the order.');
    } finally {
      setOrderSubmitting(false);
    }
  };

  const changeOrderStatus = async (order: FnbOrderRow, toStatus: FnbOrderStatusKey) => {
    await api.post(`/fnb-orders/${order.id}/status`, { toStatus });
    await fetchOrders();
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-lg font-semibold">Restaurant</h1>
        <p className="text-sm text-gray-500">The menu, order placement, and the kitchen board.</p>
      </div>

      {items === 'loading' && <p className="text-sm text-gray-500">Loading…</p>}
      {items === 'error' && <p role="alert">Could not load the menu.</p>}
      {Array.isArray(items) && items.length === 0 && <p className="text-sm text-gray-500">No menu items yet.</p>}
      {Array.isArray(items) && items.length > 0 && (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead>
              <tr className="text-left text-xs font-medium uppercase text-gray-500">
                <th className="py-2 pr-4">Name</th>
                <th className="py-2 pr-4">Category</th>
                <th className="py-2 pr-4">Price</th>
                <th className="py-2 pr-4">Prep time</th>
                <th className="py-2 pr-4">Status</th>
                {canManageMenu && <th className="py-2 pr-4" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {items.map((item) => (
                <tr key={item.id} className={item.isAvailable ? '' : 'text-gray-400'}>
                  <td className="py-2 pr-4 font-medium">{item.name}</td>
                  <td className="py-2 pr-4">{item.category}</td>
                  <td className="py-2 pr-4">{formatPeso(item.price)}</td>
                  <td className="py-2 pr-4">{item.prepMinutes ? `${item.prepMinutes} min` : '—'}</td>
                  <td className="py-2 pr-4">{item.isAvailable ? 'Available' : 'Unavailable'}</td>
                  {canManageMenu && (
                    <td className="py-2 pr-4">
                      <button
                        type="button"
                        onClick={() => void toggleAvailable(item)}
                        className="text-xs font-medium text-blue-700 hover:underline"
                      >
                        {item.isAvailable ? 'Mark unavailable' : 'Mark available'}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canManageMenu && (
        <form onSubmit={(e) => void handleCreate(e)} className="flex flex-col gap-3 rounded border border-gray-200 p-4">
          <h2 className="text-sm font-semibold text-gray-700">Add a menu item</h2>
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
              <input
                required
                placeholder="e.g. Main, Snack, Drinks"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="rounded border border-gray-300 px-2 py-1 text-sm"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-gray-600">
              Price (₱)
              <input
                required
                type="number"
                min={0}
                step="0.01"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                className="rounded border border-gray-300 px-2 py-1 text-sm"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-gray-600">
              Prep time in minutes (optional)
              <input
                type="number"
                min={1}
                value={prepMinutes}
                onChange={(e) => setPrepMinutes(e.target.value)}
                className="rounded border border-gray-300 px-2 py-1 text-sm"
              />
            </label>
          </div>
          <button
            type="submit"
            disabled={submitting}
            className="w-fit rounded bg-blue-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {submitting ? 'Adding…' : 'Add menu item'}
          </button>
        </form>
      )}

      <div className="border-t border-gray-200 pt-6">
        <h2 className="mb-2 text-sm font-semibold text-gray-700">Kitchen board</h2>

        {orders === 'loading' && <p className="text-sm text-gray-500">Loading…</p>}
        {orders === 'error' && <p role="alert">Could not load orders.</p>}
        {Array.isArray(orders) && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {BOARD_COLUMNS.map((status) => {
              const columnOrders = orders
                .filter((o) => o.status === status)
                .sort((a, b) => new Date(a.scheduledFor ?? a.createdAt).getTime() - new Date(b.scheduledFor ?? b.createdAt).getTime());
              return (
                <div key={status} className="flex flex-col gap-2">
                  <h3 className="text-xs font-semibold uppercase text-gray-500">
                    {FNB_ORDER_STATUS_LABELS[status]} ({columnOrders.length})
                  </h3>
                  {columnOrders.length === 0 && <p className="text-xs text-gray-400">No tickets.</p>}
                  {columnOrders.map((order) => {
                    const minutes = minutesSince(order.createdAt);
                    return (
                      <div key={order.id} className={`rounded border p-3 text-sm ${timerClass(minutes)}`}>
                        <div className="flex items-center justify-between">
                          <span className="font-medium">{order.referenceNo}</span>
                          <span className="text-xs font-semibold">{minutes}m</span>
                        </div>
                        <p className="text-xs text-gray-600">
                          {FNB_ORDER_TYPE_LABELS[order.type]}
                          {order.unit ? ` · ${order.unit.code}` : ''}
                          {order.guestName ? ` · ${order.guestName}` : ''}
                        </p>
                        {order.type === 'ADVANCE_ORDER' && order.scheduledFor && (
                          <p className="text-xs text-gray-600">Scheduled {new Date(order.scheduledFor).toLocaleString()}</p>
                        )}
                        <ul className="mt-1 text-xs">
                          {order.lines.map((line) => (
                            <li key={line.id}>
                              {line.qty}x {line.menuItem.name}
                            </li>
                          ))}
                        </ul>
                        <p className="mt-1 text-xs font-semibold">{formatPeso(order.subtotal)}</p>
                        {canUpdateOrderStatus && (
                          <div className="mt-2 flex flex-wrap gap-2">
                            {status === 'RECEIVED' && (
                              <>
                                <button
                                  type="button"
                                  onClick={() => void changeOrderStatus(order, 'PREPARING')}
                                  className="rounded bg-blue-700 px-2 py-1 text-xs font-medium text-white"
                                >
                                  Start preparing
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void changeOrderStatus(order, 'CANCELLED')}
                                  className="rounded border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700"
                                >
                                  Cancel
                                </button>
                              </>
                            )}
                            {status === 'PREPARING' && (
                              <>
                                <button
                                  type="button"
                                  onClick={() => void changeOrderStatus(order, 'READY')}
                                  className="rounded bg-blue-700 px-2 py-1 text-xs font-medium text-white"
                                >
                                  Mark ready
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void changeOrderStatus(order, 'CANCELLED')}
                                  className="rounded border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700"
                                >
                                  Cancel
                                </button>
                              </>
                            )}
                            {status === 'READY' && (
                              <button
                                type="button"
                                onClick={() => void changeOrderStatus(order, 'SERVED')}
                                className="rounded bg-blue-700 px-2 py-1 text-xs font-medium text-white"
                              >
                                Mark served
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}

        {canCreateOrder && (
          <form
            onSubmit={(e) => void handleCreateOrder(e)}
            className="mt-4 flex flex-col gap-3 rounded border border-gray-200 p-4"
          >
            <h3 className="text-sm font-semibold text-gray-700">Place an order</h3>
            {orderFormError && <p role="alert" className="text-sm text-red-700">{orderFormError}</p>}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-xs font-medium text-gray-600">
                Type
                <select
                  value={orderType}
                  onChange={(e) => setOrderType(e.target.value as FnbOrderTypeKey)}
                  className="rounded border border-gray-300 px-2 py-1 text-sm"
                >
                  {FNB_ORDER_TYPE_KEYS.map((key) => (
                    <option key={key} value={key}>
                      {FNB_ORDER_TYPE_LABELS[key]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-gray-600">
                Settlement (informational only)
                <select
                  value={settlement}
                  onChange={(e) => setSettlement(e.target.value as FnbSettlementKey)}
                  className="rounded border border-gray-300 px-2 py-1 text-sm"
                >
                  {FNB_SETTLEMENT_KEYS.map((key) => (
                    <option key={key} value={key}>
                      {key === 'PAY_NOW' ? 'Pay now' : 'Charge to room'}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-gray-600">
                Room {settlement === 'CHARGE_TO_ROOM' ? '(required, must be occupied)' : '(optional)'}
                <select
                  required={settlement === 'CHARGE_TO_ROOM'}
                  value={unitId}
                  onChange={(e) => setUnitId(e.target.value)}
                  className="rounded border border-gray-300 px-2 py-1 text-sm"
                >
                  <option value="">No room</option>
                  {units.map((unit) => (
                    <option key={unit.id} value={unit.id} disabled={settlement === 'CHARGE_TO_ROOM' && unit.status !== 'OCCUPIED'}>
                      {unit.code} — {unit.name} ({unit.status})
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-gray-600">
                Guest name (optional)
                <input
                  value={guestName}
                  onChange={(e) => setGuestName(e.target.value)}
                  className="rounded border border-gray-300 px-2 py-1 text-sm"
                />
              </label>
              {orderType === 'ADVANCE_ORDER' && (
                <label className="flex flex-col gap-1 text-xs font-medium text-gray-600">
                  Scheduled for
                  <input
                    required
                    type="datetime-local"
                    value={scheduledFor}
                    onChange={(e) => setScheduledFor(e.target.value)}
                    className="rounded border border-gray-300 px-2 py-1 text-sm"
                  />
                </label>
              )}
            </div>

            <div className="flex flex-col gap-2">
              <span className="text-xs font-medium text-gray-600">Items</span>
              {lines.map((line, index) => (
                <div key={index} className="flex flex-wrap items-center gap-2">
                  <select
                    required
                    value={line.menuItemId}
                    onChange={(e) => updateLine(index, { menuItemId: e.target.value })}
                    className="rounded border border-gray-300 px-2 py-1 text-sm"
                  >
                    <option value="" disabled>
                      Select an item…
                    </option>
                    {availableMenuItems.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name} ({formatPeso(item.price)})
                      </option>
                    ))}
                  </select>
                  <input
                    required
                    type="number"
                    min={1}
                    value={line.qty}
                    onChange={(e) => updateLine(index, { qty: e.target.value })}
                    className="w-16 rounded border border-gray-300 px-2 py-1 text-sm"
                  />
                  {lines.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeLine(index)}
                      className="text-xs font-medium text-red-700 hover:underline"
                    >
                      Remove
                    </button>
                  )}
                </div>
              ))}
              <button type="button" onClick={addLine} className="w-fit text-xs font-medium text-blue-700 hover:underline">
                + Add item
              </button>
            </div>

            <p className="text-sm font-semibold">Subtotal (estimate): {formatPeso(subtotalPreview)}</p>

            <button
              type="submit"
              disabled={orderSubmitting}
              className="w-fit rounded bg-blue-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {orderSubmitting ? 'Placing…' : 'Place order'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
