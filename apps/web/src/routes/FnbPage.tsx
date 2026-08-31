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
import { EmptyState } from '../components/EmptyState.js';
import { SkeletonList, SkeletonTableRows } from '../components/Skeleton.js';
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
  menuItemId: string | null;
  qty: number;
  unitPrice: number;
  notes: string | null;
  // Server-derived: the item's name snapshotted at order time, falling
  // back to the live MenuItem (pre-snapshot historical rows) and finally
  // to a placeholder once the item is genuinely deleted — see itemName
  // in apps/api/src/modules/fnb/service.ts's fnbOrderToJson.
  itemName: string;
  menuItem: { id: string; name: string } | null;
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
  cancelReason: string | null;
  cancelledBy: { fullName: string } | null;
  cancelledAt: string | null;
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

function minutesSince(dateStr: string, now: number): number {
  return Math.max(0, Math.floor((now - new Date(dateStr).getTime()) / 60_000));
}

// Client decision, 2026-08-25: live-testing found the board's timer badge
// had only two visible states (amber/red) and neither ever registered as
// "urgent" until 20+ minutes had passed — a freshly-placed ticket looked
// identical to a resolved concern. Redesigned as three explicit urgency
// tiers, all keyed off the same spec §7.3 thresholds (AMBER/RED minutes),
// just reinterpreted as "time budget consumed" rather than "still fine
// until stale": a brand-new ticket needs the kitchen's attention right
// away (red), a ticket nearing its allocation blinks to demand a look,
// and one that has actually blown past its allocation gets the strongest,
// unmistakable "OVERDUE" treatment — never disappearing back to a neutral
// badge the way the old red-only-at-35min state effectively did while the
// display sat frozen (see the ticking-clock fix below).
type OrderUrgency = 'new' | 'approaching' | 'overdue';

function orderUrgency(minutes: number): OrderUrgency {
  if (minutes >= FNB_ORDER_RED_MINUTES) return 'overdue';
  if (minutes >= FNB_ORDER_AMBER_MINUTES) return 'approaching';
  return 'new';
}

function urgencyClass(urgency: OrderUrgency): string {
  if (urgency === 'overdue') return 'border-red-600 bg-red-600 text-white animate-pulse';
  if (urgency === 'approaching') return 'border-amber-400 bg-amber-50 text-amber-900 animate-pulse';
  return 'border-red-300 bg-red-50 text-red-900';
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
  const [history, setHistory] = useState<FnbOrderRow[] | 'loading' | 'error'>('loading');
  const [historyStatusFilter, setHistoryStatusFilter] = useState<'ALL' | 'SERVED' | 'CANCELLED'>('ALL');
  const [historySearch, setHistorySearch] = useState('');
  const [historySortAsc, setHistorySortAsc] = useState(false);
  const [units, setUnits] = useState<OrderableUnit[]>([]);
  const [orderType, setOrderType] = useState<FnbOrderTypeKey>('DINE_IN');
  const [settlement, setSettlement] = useState<FnbSettlementKey>('PAY_NOW');
  const [unitId, setUnitId] = useState('');
  const [guestName, setGuestName] = useState('');
  const [scheduledFor, setScheduledFor] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([{ menuItemId: '', qty: '1' }]);
  const [orderFormError, setOrderFormError] = useState<string | null>(null);
  const [orderSubmitting, setOrderSubmitting] = useState(false);
  const [cancellingOrderId, setCancellingOrderId] = useState<string | null>(null);
  const [cancelReasonDraft, setCancelReasonDraft] = useState('');
  const [cancelError, setCancelError] = useState<string | null>(null);

  // Ticking clock for the board's elapsed-time badges, decoupled from
  // fetchOrders's 30s poll/realtime cadence. Real bug found live-testing:
  // without this, minutesSince was only ever recomputed as a side effect
  // of a fresh fetch — an order sitting untouched in RECEIVED between
  // fetches (or between realtime events) showed the exact same badge for
  // however long the gap happened to be, rather than visibly advancing.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(interval);
  }, []);

  const fetchOrders = () => {
    setOrders('loading');
    return api
      .get<{ fnbOrders: FnbOrderRow[] }>('/fnb-orders?boardOnly=true')
      .then((res) => setOrders(res.fnbOrders))
      .catch(() => setOrders('error'));
  };

  // Real gap found live-testing, 2026-08-25: once an order left the
  // active kanban board (SERVED or CANCELLED), its full detail was only
  // visible by digging into Supabase directly — no page showed it, with
  // a cancellation reason or otherwise. This is that view: every
  // SERVED/CANCELLED order, newest first (server-sorted, capped at 200 —
  // see listFnbOrders in service.ts), filtered/searched/sorted further
  // client-side below.
  const fetchHistory = () => {
    setHistory('loading');
    return api
      .get<{ fnbOrders: FnbOrderRow[] }>('/fnb-orders?history=true')
      .then((res) => setHistory(res.fnbOrders))
      .catch(() => setHistory('error'));
  };

  useEffect(() => {
    void fetchItems();
    void fetchOrders();
    void fetchHistory();
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
    const interval = setInterval(() => {
      void fetchOrders();
      void fetchHistory();
    }, 30_000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeToFnbOrderChanges(
      () => {
        void fetchOrders();
        void fetchHistory();
      },
      () => {},
    );
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

  // Client decision, 2026-08-25 (Option B): a real delete, now that
  // FnbOrderLine snapshots the item's name/price at order time. The
  // server still refuses (409) unless the item is already unavailable —
  // this confirm dialog is a second, client-side guard on top of that.
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deleteItem = async (item: MenuItemRow) => {
    if (!window.confirm(`Permanently delete "${item.name}"? This cannot be undone.`)) return;
    setDeleteError(null);
    try {
      await api.delete(`/menu-items/${item.id}`);
      await fetchItems();
    } catch (err) {
      setDeleteError(err instanceof ApiRequestError ? err.message : 'Could not delete the menu item.');
    }
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

  const startCancel = (order: FnbOrderRow) => {
    setCancellingOrderId(order.id);
    setCancelReasonDraft('');
    setCancelError(null);
  };

  const confirmCancel = async (order: FnbOrderRow) => {
    if (!cancelReasonDraft.trim()) {
      setCancelError('A cancellation reason is required.');
      return;
    }
    setCancelError(null);
    try {
      await api.post(`/fnb-orders/${order.id}/status`, { toStatus: 'CANCELLED', cancelReason: cancelReasonDraft.trim() });
      setCancellingOrderId(null);
      setCancelReasonDraft('');
      await fetchOrders();
      await fetchHistory();
    } catch (err) {
      setCancelError(err instanceof ApiRequestError ? err.message : 'Could not cancel the order.');
    }
  };

  // Groups the menu (and the order-line picker) by whatever `category`
  // values actually exist in the live data — MenuItem.category is free
  // text, not a fixed enum, so this stays correct however the seeded/real
  // categories are named rather than assuming any particular set.
  const menuCategories = Array.isArray(items) ? [...new Set(items.map((item) => item.category))].sort() : [];

  const visibleHistory = (Array.isArray(history) ? history : [])
    .filter((order) => historyStatusFilter === 'ALL' || order.status === historyStatusFilter)
    .filter((order) => {
      const term = historySearch.trim().toLowerCase();
      if (!term) return true;
      return (
        order.referenceNo.toLowerCase().includes(term) ||
        (order.guestName ?? '').toLowerCase().includes(term) ||
        (order.unit ? `${order.unit.code} ${order.unit.name}`.toLowerCase().includes(term) : false)
      );
    })
    .sort((a, b) => {
      const diff = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      return historySortAsc ? diff : -diff;
    });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-lg font-semibold">Restaurant</h1>
        <p className="text-sm text-gray-500">The menu, order placement, and the kitchen board.</p>
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-gray-700">Kitchen board</h2>

        {orders === 'loading' && <SkeletonList />}
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
                  {columnOrders.length === 0 && <EmptyState message="No tickets." />}
                  {columnOrders.map((order) => {
                    const minutes = minutesSince(order.createdAt, now);
                    const urgency = orderUrgency(minutes);
                    return (
                      <div key={order.id} className={`rounded border p-3 text-sm ${urgencyClass(urgency)}`}>
                        <div className="flex items-center justify-between">
                          <span className="font-medium">{order.referenceNo}</span>
                          <span className="text-xs font-semibold">
                            {urgency === 'overdue' ? `OVERDUE · ${minutes}m` : `${minutes}m`}
                          </span>
                        </div>
                        <p className={`text-xs ${urgency === 'overdue' ? 'text-red-50' : 'text-gray-600'}`}>
                          {FNB_ORDER_TYPE_LABELS[order.type]}
                          {order.unit ? ` · ${order.unit.code}` : ''}
                          {order.guestName ? ` · ${order.guestName}` : ''}
                        </p>
                        {order.type === 'ADVANCE_ORDER' && order.scheduledFor && (
                          <p className={`text-xs ${urgency === 'overdue' ? 'text-red-50' : 'text-gray-600'}`}>
                            Scheduled {new Date(order.scheduledFor).toLocaleString()}
                          </p>
                        )}
                        <ul className="mt-1 text-xs">
                          {order.lines.map((line) => (
                            <li key={line.id}>
                              {line.qty}x {line.itemName}
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
                                  onClick={() => startCancel(order)}
                                  className="rounded border border-gray-300 bg-white px-2 py-1 text-xs font-medium text-gray-700"
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
                                  onClick={() => startCancel(order)}
                                  className="rounded border border-gray-300 bg-white px-2 py-1 text-xs font-medium text-gray-700"
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
                        {cancellingOrderId === order.id && (
                          <div className="mt-2 flex flex-col gap-2 rounded border border-gray-300 bg-white p-2 text-gray-900">
                            {cancelError && <p role="alert" className="text-xs text-red-700">{cancelError}</p>}
                            <label className="flex flex-col gap-1 text-xs font-medium text-gray-600">
                              Cancellation reason (required)
                              <input
                                required
                                autoFocus
                                value={cancelReasonDraft}
                                onChange={(e) => setCancelReasonDraft(e.target.value)}
                                className="rounded border border-gray-300 px-2 py-1 text-xs"
                              />
                            </label>
                            <div className="flex gap-2">
                              <button
                                type="button"
                                onClick={() => void confirmCancel(order)}
                                className="rounded bg-red-700 px-2 py-1 text-xs font-medium text-white"
                              >
                                Confirm cancel
                              </button>
                              <button
                                type="button"
                                onClick={() => setCancellingOrderId(null)}
                                className="rounded border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700"
                              >
                                Keep order
                              </button>
                            </div>
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
                  {/*
                    Real bug found live-testing, 2026-08-25: this was only
                    disabled when settlement === 'CHARGE_TO_ROOM', but
                    settlement defaults to PAY_NOW, so every room —
                    including BLOCKED/OUT_OF_ORDER — was clickable by
                    default. An F&B order should only ever attach to a room
                    with a guest actually present, regardless of how it's
                    paid for, so this is unconditional now — same
                    never-even-try disabled-option treatment as
                    UnitsPage's CheckInPanel isBookable().
                  */}
                  {units.map((unit) => (
                    <option key={unit.id} value={unit.id} disabled={unit.status !== 'OCCUPIED'}>
                      {unit.code} — {unit.name} ({unit.status})
                    </option>
                  ))}
                </select>
                <span className="text-xs font-normal text-gray-400">
                  (only occupied rooms can be selected; other rooms are shown but disabled)
                </span>
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

      <div className="border-t border-gray-200 pt-6">
        <h2 className="mb-2 text-sm font-semibold text-gray-700">Order history</h2>
        <p className="mb-2 text-xs text-gray-500">
          Every completed or cancelled order's full detail — items, room, guest, cancellation reason, timestamps. Once an
          order leaves the kitchen board, this is where it lives.
        </p>

        <div className="mb-3 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs font-medium text-gray-600">
            Status
            <select
              value={historyStatusFilter}
              onChange={(e) => setHistoryStatusFilter(e.target.value as 'ALL' | 'SERVED' | 'CANCELLED')}
              className="rounded border border-gray-300 px-2 py-1 text-sm"
            >
              <option value="ALL">All</option>
              <option value="SERVED">Completed</option>
              <option value="CANCELLED">Cancelled</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-gray-600">
            Search
            <input
              value={historySearch}
              onChange={(e) => setHistorySearch(e.target.value)}
              placeholder="Reference #, guest, or room"
              className="rounded border border-gray-300 px-2 py-1 text-sm"
            />
          </label>
          <button
            type="button"
            onClick={() => setHistorySortAsc((prev) => !prev)}
            className="rounded border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700"
          >
            Date: {historySortAsc ? 'Oldest first' : 'Newest first'}
          </button>
        </div>

        {history === 'loading' && (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <tbody>
                <SkeletonTableRows rows={4} columns={7} />
              </tbody>
            </table>
          </div>
        )}
        {history === 'error' && <p role="alert">Could not load order history.</p>}
        {Array.isArray(history) && visibleHistory.length === 0 && <EmptyState message="No matching orders." />}
        {Array.isArray(history) && visibleHistory.length > 0 && (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead>
                <tr className="text-left text-xs font-medium uppercase text-gray-500">
                  <th className="py-2 pr-4">Reference</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4">Placed</th>
                  <th className="py-2 pr-4">Room / Guest</th>
                  <th className="py-2 pr-4">Items</th>
                  <th className="py-2 pr-4">Total</th>
                  <th className="py-2 pr-4">Detail</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {visibleHistory.map((order) => (
                  <tr key={order.id}>
                    <td className="py-2 pr-4 font-medium">{order.referenceNo}</td>
                    <td className="py-2 pr-4">{FNB_ORDER_STATUS_LABELS[order.status]}</td>
                    <td className="py-2 pr-4">{new Date(order.createdAt).toLocaleString()}</td>
                    <td className="py-2 pr-4">
                      {order.unit ? order.unit.code : '—'}
                      {order.guestName ? ` · ${order.guestName}` : ''}
                    </td>
                    <td className="py-2 pr-4">
                      <ul>
                        {order.lines.map((line) => (
                          <li key={line.id}>
                            {line.qty}x {line.itemName}
                          </li>
                        ))}
                      </ul>
                    </td>
                    <td className="py-2 pr-4">{formatPeso(order.subtotal)}</td>
                    <td className="py-2 pr-4 text-xs text-gray-600">
                      {order.status === 'CANCELLED' && (
                        <>
                          {order.cancelReason ?? 'No reason recorded'}
                          {order.cancelledBy ? ` — ${order.cancelledBy.fullName}` : ''}
                          {order.cancelledAt ? `, ${new Date(order.cancelledAt).toLocaleString()}` : ''}
                        </>
                      )}
                      {order.status === 'SERVED' && `Placed by ${order.createdBy.fullName}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="border-t border-gray-200 pt-6">
        <h2 className="mb-2 text-sm font-semibold text-gray-700">Menu</h2>
        {deleteError && <p role="alert" className="mb-2 text-sm text-red-700">{deleteError}</p>}

        {items === 'loading' && (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <tbody>
                <SkeletonTableRows rows={4} columns={4} />
              </tbody>
            </table>
          </div>
        )}
        {items === 'error' && <p role="alert">Could not load the menu.</p>}
        {Array.isArray(items) && items.length === 0 && <EmptyState message="No menu items yet." />}
        {Array.isArray(items) && items.length > 0 && (
          <div className="flex flex-col gap-6">
            {menuCategories.map((cat) => (
              <div key={cat} className="overflow-x-auto">
                <h3 className="mb-1 text-xs font-semibold uppercase text-gray-500">{cat}</h3>
                <table className="min-w-full divide-y divide-gray-200 text-sm">
                  <thead>
                    <tr className="text-left text-xs font-medium uppercase text-gray-500">
                      <th className="py-2 pr-4">Name</th>
                      <th className="py-2 pr-4">Price</th>
                      <th className="py-2 pr-4">Prep time</th>
                      <th className="py-2 pr-4">Status</th>
                      {canManageMenu && <th className="py-2 pr-4" colSpan={2} />}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {(items as MenuItemRow[])
                      .filter((item) => item.category === cat)
                      .map((item) => (
                        <tr key={item.id} className={item.isAvailable ? '' : 'text-gray-400'}>
                          <td className="py-2 pr-4 font-medium">{item.name}</td>
                          <td className="py-2 pr-4">{formatPeso(item.price)}</td>
                          <td className="py-2 pr-4">{item.prepMinutes ? `${item.prepMinutes} min` : '—'}</td>
                          <td className="py-2 pr-4">{item.isAvailable ? 'Available' : 'Unavailable'}</td>
                          {canManageMenu && (
                            <>
                              <td className="py-2 pr-4">
                                <button
                                  type="button"
                                  onClick={() => void toggleAvailable(item)}
                                  className="text-xs font-medium text-blue-700 hover:underline"
                                >
                                  {item.isAvailable ? 'Mark unavailable' : 'Mark available'}
                                </button>
                              </td>
                              <td className="py-2 pr-4">
                                {/*
                                  Client decision, 2026-08-25 (Option B):
                                  only offered once the item is already
                                  unavailable — matches the server's own
                                  409 ITEM_STILL_AVAILABLE guard, so this
                                  never fires a request that's certain to
                                  be refused.
                                */}
                                {!item.isAvailable && (
                                  <button
                                    type="button"
                                    onClick={() => void deleteItem(item)}
                                    className="text-xs font-medium text-red-700 hover:underline"
                                  >
                                    Delete
                                  </button>
                                )}
                              </td>
                            </>
                          )}
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        )}

        {canManageMenu && (
          <form onSubmit={(e) => void handleCreate(e)} className="mt-4 flex flex-col gap-3 rounded border border-gray-200 p-4">
            <h3 className="text-sm font-semibold text-gray-700">Add a menu item</h3>
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
                  placeholder="e.g. Rice Meals, Silog, Grilled, Pulutan, Drinks, Desserts"
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
      </div>
    </div>
  );
}
