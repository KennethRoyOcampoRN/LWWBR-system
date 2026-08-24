import { useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '../context/AuthContext.js';
import { api, ApiRequestError } from '../lib/api.js';

interface MenuItemRow {
  id: string;
  name: string;
  category: string;
  price: number;
  isAvailable: boolean;
  prepMinutes: number | null;
  sortOrder: number;
}

function formatPeso(amount: number): string {
  return `₱${amount.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Restaurant menu — spec §6 MenuItem, §8.2's F&B module. First M5
// restaurant slice: the menu only (order creation + kitchen kanban is a
// separate, later slice). `category` is free text here, unlike
// AmenityItem's closed enum — spec's own data model leaves MenuItem.
// category as a plain string, so the form does too rather than inventing
// a category list the client never asked for.
export function FnbPage() {
  const { user } = useAuth();
  const canManageMenu = Boolean(user?.permissions['fnb:manage_menu']);

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

  useEffect(() => {
    void fetchItems();
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

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-lg font-semibold">Restaurant</h1>
        <p className="text-sm text-gray-500">
          The menu — order creation and the kitchen board are not built yet.
        </p>
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
    </div>
  );
}
