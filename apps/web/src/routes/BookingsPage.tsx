import {
  BOOKING_SOURCE_KEYS,
  BOOKING_TYPE_KEYS,
  type AnyUnitStatusKey,
  type BookingSourceKey,
  type BookingStatusKey,
  type BookingTypeKey,
} from '@lwwbr/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiRequestError } from '../lib/api.js';
import { BOOKING_SOURCE_LABELS, BOOKING_TYPE_LABELS } from '../lib/bookingStyle.js';
import { UNIT_STATUS_CLASSES, UNIT_STATUS_LABELS } from '../lib/unitStatusStyle.js';

interface BookingSearchUnit {
  unitId: string;
  rate: number;
  unit: { id: string; code: string; name: string; status: AnyUnitStatusKey };
}

interface BookingSearchResult {
  id: string;
  referenceNo: string;
  guestName: string;
  type: BookingTypeKey;
  status: BookingStatusKey;
  startAt: string;
  endAt: string;
  units: BookingSearchUnit[];
}

function formatBookingWindow(booking: { type: BookingTypeKey; startAt: string; endAt: string }): string {
  const opts: Intl.DateTimeFormatOptions = { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' };
  return `${new Date(booking.startAt).toLocaleString('en-PH', opts)} – ${new Date(booking.endAt).toLocaleString('en-PH', opts)}`;
}

// Urgent gap, 2026-08-23: "with check-in not yet built, there's
// currently no way to process this guest's arrival at all." One lookup
// panel drives both actions — "input an existing Booking ID (or guest
// name lookup), confirm arrival" — since the same search (guest name or
// reference number) finds both a booking awaiting arrival and one
// currently checked in, the button shown just follows whatever the
// booking's own status allows next, via the shared BOOKING_TRANSITIONS
// table (mirrors how the work order detail drawer derives its own
// transition buttons).
function CheckInOutPanel({ onProcessed }: { onProcessed: () => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<BookingSearchResult[] | 'idle' | 'loading' | 'error'>('idle');
  const [selected, setSelected] = useState<BookingSearchResult | null>(null);
  const [notReadyWarning, setNotReadyWarning] = useState<{ unitCode: string; unitStatus: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  async function handleSearch(e: FormEvent) {
    e.preventDefault();
    setSelected(null);
    setNotReadyWarning(null);
    setActionError(null);
    setSuccessMessage(null);
    const trimmed = query.trim();
    if (!trimmed) return;
    setResults('loading');
    try {
      const res = await api.get<{ bookings: BookingSearchResult[] }>(`/bookings?search=${encodeURIComponent(trimmed)}`);
      setResults(res.bookings);
    } catch {
      setResults('error');
    }
  }

  function selectBooking(booking: BookingSearchResult) {
    setSelected(booking);
    setNotReadyWarning(null);
    setActionError(null);
    setSuccessMessage(null);
  }

  async function confirmArrival(acknowledgeNotReady = false) {
    if (!selected) return;
    setSubmitting(true);
    setActionError(null);
    try {
      await api.post(`/bookings/${selected.id}/checkin`, acknowledgeNotReady ? { acknowledgeNotReady: true } : {});
      setSuccessMessage(`${selected.referenceNo} checked in — ${selected.guestName}.`);
      setNotReadyWarning(null);
      setSelected(null);
      setResults('idle');
      setQuery('');
      onProcessed();
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'UNIT_NOT_READY') {
        const details = err.details as { unitCode?: string; unitStatus?: string } | undefined;
        setNotReadyWarning({ unitCode: details?.unitCode ?? 'The unit', unitStatus: details?.unitStatus ?? 'not ready' });
      } else if (err instanceof ApiRequestError && err.code === 'UNIT_UNAVAILABLE') {
        const details = err.details as { unitCode?: string } | undefined;
        setActionError(`${details?.unitCode ?? 'That unit'} cannot be checked in right now — ${err.message}`);
      } else {
        setActionError(err instanceof ApiRequestError ? err.message : 'Could not check in this booking.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function confirmDeparture() {
    if (!selected) return;
    setSubmitting(true);
    setActionError(null);
    try {
      await api.post(`/bookings/${selected.id}/checkout`, {});
      setSuccessMessage(`${selected.referenceNo} checked out — ${selected.guestName}.`);
      setSelected(null);
      setResults('idle');
      setQuery('');
      onProcessed();
    } catch (err) {
      setActionError(err instanceof ApiRequestError ? err.message : 'Could not check out this booking.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded border border-blue-300 bg-blue-50 p-4">
      <h2 className="text-sm font-semibold">Check-in / check-out</h2>
      <form onSubmit={(e) => void handleSearch(e)} className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-sm">
          Booking reference or guest name
          <input
            className="w-64 rounded border border-gray-300 px-2 py-1"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="e.g. LWW-260823-0003 or Jane"
          />
        </label>
        <button type="submit" className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white">
          Look up
        </button>
      </form>

      {results === 'loading' && <p className="text-sm text-gray-500">Searching…</p>}
      {results === 'error' && <p role="alert" className="text-sm text-red-600">Could not search bookings.</p>}
      {Array.isArray(results) && results.length === 0 && (
        <p className="text-sm text-gray-500">No matching bookings awaiting arrival or currently checked in.</p>
      )}
      {Array.isArray(results) && results.length > 0 && !selected && (
        <ul className="flex flex-col gap-1">
          {results.map((booking) => (
            <li key={booking.id}>
              <button
                type="button"
                onClick={() => selectBooking(booking)}
                className="flex w-full flex-wrap items-center gap-2 rounded border border-gray-200 bg-white p-2 text-left text-sm hover:border-blue-400"
              >
                <span className="font-mono text-xs text-gray-500">{booking.referenceNo}</span>
                <span className="font-medium">{booking.guestName}</span>
                <span className="text-xs text-gray-500">
                  {BOOKING_TYPE_LABELS[booking.type]} · {formatBookingWindow(booking)}
                </span>
                <span className="text-xs text-gray-500">{booking.status === 'CHECKED_IN' ? 'Checked in' : 'Awaiting arrival'}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {selected && (
        <div className="flex flex-col gap-2 rounded border border-gray-200 bg-white p-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold">{selected.guestName}</p>
              <p className="text-xs font-mono text-gray-500">{selected.referenceNo}</p>
            </div>
            <button onClick={() => setSelected(null)} className="text-xs text-gray-500 hover:underline">
              Back to results
            </button>
          </div>
          <p className="text-sm text-gray-700">
            {BOOKING_TYPE_LABELS[selected.type]} · {formatBookingWindow(selected)}
          </p>
          <ul className="flex flex-wrap gap-2">
            {selected.units.map((u) => (
              <li key={u.unitId} className="flex items-center gap-1 text-sm">
                {u.unit.code} — {u.unit.name}
                <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${UNIT_STATUS_CLASSES[u.unit.status]}`}>
                  {UNIT_STATUS_LABELS[u.unit.status]}
                </span>
              </li>
            ))}
          </ul>

          {notReadyWarning && (
            <div role="alert" className="flex flex-col gap-2 rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900">
              <p>
                {notReadyWarning.unitCode} is not Ready yet (currently {UNIT_STATUS_LABELS[notReadyWarning.unitStatus as AnyUnitStatusKey] ?? notReadyWarning.unitStatus}). Spec §7.5: real
                check-ins happen while the room is still being finished — this is a warning, not a hard block.
              </p>
              <button
                onClick={() => void confirmArrival(true)}
                disabled={submitting}
                className="w-fit rounded border border-amber-600 bg-amber-100 px-3 py-1.5 text-sm font-medium text-amber-900 disabled:opacity-50"
              >
                {submitting ? 'Checking in…' : 'Check in anyway'}
              </button>
            </div>
          )}

          {actionError && (
            <p role="alert" className="text-sm text-red-600">
              {actionError}
            </p>
          )}

          {!notReadyWarning && (selected.status === 'PENDING' || selected.status === 'CONFIRMED') && (
            <button
              onClick={() => void confirmArrival(false)}
              disabled={submitting}
              className="w-fit rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {submitting ? 'Checking in…' : 'Confirm arrival'}
            </button>
          )}
          {selected.status === 'CHECKED_IN' && (
            <button
              onClick={() => void confirmDeparture()}
              disabled={submitting}
              className="w-fit rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {submitting ? 'Checking out…' : 'Confirm departure (check out)'}
            </button>
          )}
        </div>
      )}

      {successMessage && (
        <p role="status" className="text-sm font-medium text-green-800">
          {successMessage}
        </p>
      )}
    </div>
  );
}

interface UnitOption {
  id: string;
  code: string;
  name: string;
  unitTypeId: string;
  status: AnyUnitStatusKey;
  isActive: boolean;
}

interface UnitTypeOption {
  id: string;
  name: string;
  baseRate: number;
  dayTourRate: number | null;
}

interface CreatedBooking {
  referenceNo: string;
  guestName: string;
  type: BookingTypeKey;
  startAt: string;
  endAt: string;
  totalAmount: number;
  units: { unitId: string; rate: number; unit: { code: string; name: string } }[];
}

// Spec §7.5: "A unit that is OUT_OF_ORDER or BLOCKED cannot be assigned
// at all" — pre-filtered client-side so the cashier never even tries to
// pick one, though the server enforces the same rule regardless (this is
// UX only, never the real gate — same principle as the work order photo-
// requirement hint).
function isBookable(unit: UnitOption): boolean {
  return unit.isActive && unit.status !== 'OUT_OF_ORDER' && unit.status !== 'BLOCKED';
}

const initialFormState = {
  guestName: '',
  guestPhone: '',
  guestEmail: '',
  source: 'WALK_IN' as BookingSourceKey,
  type: 'OVERNIGHT' as BookingTypeKey,
  arrivalDate: '',
  departureDate: '',
  pax: 1,
  childrenPax: 0,
  notes: '',
};

export function BookingsPage() {
  const [units, setUnits] = useState<UnitOption[] | 'loading' | 'error'>('loading');
  const [unitTypes, setUnitTypes] = useState<UnitTypeOption[]>([]);
  const [form, setForm] = useState(initialFormState);
  const [selectedUnitIds, setSelectedUnitIds] = useState<string[]>([]);
  const [rates, setRates] = useState<Record<string, number>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedBooking | null>(null);

  function refetchUnits() {
    api
      .get<{ units: UnitOption[] }>('/units')
      .then((res) => setUnits(res.units))
      .catch(() => setUnits('error'));
  }

  useEffect(() => {
    refetchUnits();
    api
      .get<{ unitTypes: UnitTypeOption[] }>('/unit-types')
      .then((res) => setUnitTypes(res.unitTypes))
      .catch(() => setUnitTypes([]));
  }, []);

  const unitTypeById = new Map(unitTypes.map((t) => [t.id, t]));

  function defaultRateFor(unit: UnitOption, type: BookingTypeKey): number {
    const unitType = unitTypeById.get(unit.unitTypeId);
    if (!unitType) return 0;
    if (type === 'DAY_TOUR') return unitType.dayTourRate ?? unitType.baseRate;
    return unitType.baseRate;
  }

  function toggleUnit(unit: UnitOption) {
    setSelectedUnitIds((prev) => {
      if (prev.includes(unit.id)) {
        return prev.filter((id) => id !== unit.id);
      }
      // Auto-fill the rate at the moment of selection — spec §8.3: "rate
      // auto-filled from UnitType and overridable." Recomputing on every
      // later change to `type` would silently clobber a cashier's manual
      // override, so this only happens once, here.
      setRates((r) => ({ ...r, [unit.id]: r[unit.id] ?? defaultRateFor(unit, form.type) }));
      return [...prev, unit.id];
    });
  }

  const nights =
    form.type === 'OVERNIGHT' && form.arrivalDate && form.departureDate
      ? Math.max(1, Math.round((new Date(form.departureDate).getTime() - new Date(form.arrivalDate).getTime()) / 86_400_000))
      : 1;
  const estimatedTotal = selectedUnitIds.reduce((sum, id) => sum + (rates[id] ?? 0), 0) * nights;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    setCreated(null);
    if (selectedUnitIds.length === 0) {
      setSubmitError('Select at least one unit.');
      return;
    }
    setSubmitting(true);
    try {
      const result = await api.post<{ booking: CreatedBooking }>('/bookings', {
        guestName: form.guestName.trim(),
        guestPhone: form.guestPhone.trim() || undefined,
        guestEmail: form.guestEmail.trim() || undefined,
        source: form.source,
        type: form.type,
        arrivalDate: form.arrivalDate,
        departureDate: form.type === 'OVERNIGHT' ? form.departureDate : undefined,
        pax: form.pax,
        childrenPax: form.childrenPax,
        units: selectedUnitIds.map((id) => ({ unitId: id, rate: rates[id] })),
        notes: form.notes.trim() || undefined,
      });
      setCreated(result.booking);
      setForm(initialFormState);
      setSelectedUnitIds([]);
      setRates({});
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'UNIT_UNAVAILABLE') {
        const details = err.details as { unitCode?: string; conflictingReferenceNo?: string; reason?: string } | undefined;
        if (details?.conflictingReferenceNo) {
          setSubmitError(
            `${details.unitCode ?? 'That unit'} is already booked (${details.conflictingReferenceNo}) for those dates. Pick a different unit or date.`,
          );
        } else {
          setSubmitError(`${details?.unitCode ?? 'That unit'} cannot be booked right now (${details?.reason ?? 'unavailable'}).`);
        }
      } else {
        setSubmitError(err instanceof ApiRequestError ? err.message : 'Could not create the booking.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-lg font-semibold">Bookings</h1>

      {/* Urgent priority, 2026-08-23: check-in/check-out sits above "New
          booking" — a guest waiting at the desk to arrive or depart is a
          more time-sensitive action than starting a new reservation. */}
      <CheckInOutPanel onProcessed={refetchUnits} />

      <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-3 rounded border border-gray-200 p-4">
        <h2 className="text-sm font-semibold">New booking</h2>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            Guest name
            <input
              required
              className="rounded border border-gray-300 px-2 py-1"
              value={form.guestName}
              onChange={(e) => setForm((f) => ({ ...f, guestName: e.target.value }))}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Contact number
            <input
              className="rounded border border-gray-300 px-2 py-1"
              value={form.guestPhone}
              onChange={(e) => setForm((f) => ({ ...f, guestPhone: e.target.value }))}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Email (optional)
            <input
              type="email"
              className="rounded border border-gray-300 px-2 py-1"
              value={form.guestEmail}
              onChange={(e) => setForm((f) => ({ ...f, guestEmail: e.target.value }))}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Source
            <select
              className="rounded border border-gray-300 px-2 py-1"
              value={form.source}
              onChange={(e) => setForm((f) => ({ ...f, source: e.target.value as BookingSourceKey }))}
            >
              {BOOKING_SOURCE_KEYS.map((source) => (
                <option key={source} value={source}>
                  {BOOKING_SOURCE_LABELS[source]}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-sm">
            Type
            <select
              className="rounded border border-gray-300 px-2 py-1"
              value={form.type}
              onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as BookingTypeKey, departureDate: '' }))}
            >
              {BOOKING_TYPE_KEYS.map((type) => (
                <option key={type} value={type}>
                  {BOOKING_TYPE_LABELS[type]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {form.type === 'DAY_TOUR' ? 'Date' : 'Arrival date'}
            <input
              required
              type="date"
              className="rounded border border-gray-300 px-2 py-1"
              value={form.arrivalDate}
              onChange={(e) => setForm((f) => ({ ...f, arrivalDate: e.target.value }))}
            />
          </label>
          {form.type === 'OVERNIGHT' && (
            <label className="flex flex-col gap-1 text-sm">
              Departure date
              <input
                required
                type="date"
                className="rounded border border-gray-300 px-2 py-1"
                value={form.departureDate}
                onChange={(e) => setForm((f) => ({ ...f, departureDate: e.target.value }))}
              />
            </label>
          )}
          {form.type === 'DAY_TOUR' && (
            <p className="self-end text-xs text-gray-500">Fixed block: 9:00 AM – 5:00 PM.</p>
          )}

          <label className="flex flex-col gap-1 text-sm">
            Pax
            <input
              required
              type="number"
              min={1}
              className="rounded border border-gray-300 px-2 py-1"
              value={form.pax}
              onChange={(e) => setForm((f) => ({ ...f, pax: Number(e.target.value) }))}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Children
            <input
              type="number"
              min={0}
              className="rounded border border-gray-300 px-2 py-1"
              value={form.childrenPax}
              onChange={(e) => setForm((f) => ({ ...f, childrenPax: Number(e.target.value) }))}
            />
          </label>
        </div>

        <label className="flex flex-col gap-1 text-sm">
          Notes (optional)
          <textarea
            className="rounded border border-gray-300 px-2 py-1"
            rows={2}
            value={form.notes}
            onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
          />
        </label>

        <div className="flex flex-col gap-2 rounded border border-gray-200 bg-gray-50 p-3">
          <p className="text-sm font-medium">
            Units
            <span className="ml-1 text-xs font-normal text-gray-500">
              (out-of-order/blocked units are shown but cannot be selected — final availability is still checked on submit)
            </span>
          </p>
          {units === 'loading' && <p className="text-xs text-gray-500">Loading units…</p>}
          {units === 'error' && <p role="alert" className="text-xs text-red-600">Could not load units.</p>}
          {Array.isArray(units) && (
            <ul className="flex flex-col gap-1">
              {units.map((unit) => {
                const bookable = isBookable(unit);
                const checked = selectedUnitIds.includes(unit.id);
                return (
                  <li key={unit.id} className="flex flex-wrap items-center gap-2 text-sm">
                    <label className={`flex items-center gap-2 ${bookable ? '' : 'opacity-50'}`}>
                      <input
                        type="checkbox"
                        disabled={!bookable}
                        checked={checked}
                        onChange={() => toggleUnit(unit)}
                      />
                      {unit.code} — {unit.name}
                    </label>
                    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${UNIT_STATUS_CLASSES[unit.status]}`}>
                      {UNIT_STATUS_LABELS[unit.status]}
                    </span>
                    {checked && (
                      <label className="flex items-center gap-1 text-xs text-gray-600">
                        Rate
                        <input
                          type="number"
                          min={0}
                          step="0.01"
                          className="w-24 rounded border border-gray-300 px-1 py-0.5"
                          value={rates[unit.id] ?? 0}
                          onChange={(e) => setRates((r) => ({ ...r, [unit.id]: Number(e.target.value) }))}
                        />
                      </label>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {selectedUnitIds.length > 0 && (
          <p className="text-sm text-gray-700">
            Estimated total: <span className="font-semibold">₱{estimatedTotal.toLocaleString()}</span>
            {form.type === 'OVERNIGHT' && nights > 1 ? ` (${nights} nights)` : ''}
            <span className="ml-1 text-xs text-gray-500">— final total is computed server-side</span>
          </p>
        )}

        {submitError && (
          <p role="alert" className="text-sm text-red-600">
            {submitError}
          </p>
        )}
        {created && (
          <div role="status" className="rounded border border-green-300 bg-green-50 p-3 text-sm text-green-900">
            <p className="font-semibold">
              Created {created.referenceNo} for {created.guestName}.
            </p>
            <p>
              {BOOKING_TYPE_LABELS[created.type]}: {new Date(created.startAt).toLocaleString('en-PH', { timeZone: 'Asia/Manila' })} –{' '}
              {new Date(created.endAt).toLocaleString('en-PH', { timeZone: 'Asia/Manila' })}
            </p>
            <p>
              Units: {created.units.map((u) => `${u.unit.code} (₱${u.rate.toLocaleString()})`).join(', ')} — Total: ₱
              {created.totalAmount.toLocaleString()}
            </p>
          </div>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="w-fit rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {submitting ? 'Creating…' : 'Create booking'}
        </button>
      </form>
    </div>
  );
}
