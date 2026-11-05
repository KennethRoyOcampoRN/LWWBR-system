import { isBookableUnitKind, type BookingStatusKey } from '@lwwbr/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '../components/Button.js';
import { Card, Section } from '../components/Card.js';
import { EmptyState } from '../components/EmptyState.js';
import { Field, INPUT_CLASSES } from '../components/Field.js';
import { PageHeader } from '../components/PageHeader.js';
import { StatusBadge } from '../components/StatusBadge.js';
import { BOOKING_STATUS_BADGE_VARIANT, BOOKING_STATUS_LABELS } from '../lib/bookingStyle.js';
import { api, ApiRequestError } from '../lib/api.js';

interface BookingRow {
  id: string;
  referenceNo: string;
  guestName: string;
  status: BookingStatusKey;
  arrivalDate: string;
  departureDate: string | null;
  endAt: string | null;
  units: { code: string; name: string }[];
}

interface ReadyUnit {
  id: string;
  code: string;
  name: string;
  type: string;
  status: string;
}

const EMPTY_PRE_ARRIVAL_FORM = {
  guestName: '',
  externalBookingId: '',
  checkInDate: '',
  checkOutDate: '',
  unitId: '',
  notes: '',
};

// Cashier-tab plan, Stage C (2026-11-05): the standalone picker — "find
// this guest's bill," client's own framing, not "is this guest
// pre-arrival or in-house" (searchBookings's own scope correction, same
// decision). One list for the default/in-house view; `status` on each
// row is what keeps a pre-arrival booking visually distinguishable from
// a checked-in one, same approach as the unit card. `recent` stays its
// own explicit scope (recently departed), not folded into this list.
export function CashierPage() {
  const [scope, setScope] = useState<'in_house' | 'recent'>('in_house');
  const [q, setQ] = useState('');
  const [bookings, setBookings] = useState<BookingRow[] | 'loading' | 'error'>('loading');
  const [showNewForm, setShowNewForm] = useState(false);

  function fetchBookings() {
    setBookings('loading');
    const params = new URLSearchParams();
    if (q.trim()) params.set('q', q.trim());
    else params.set('scope', scope);
    api
      .get<{ bookings: BookingRow[] }>(`/bookings/search?${params.toString()}`)
      .then((res) => setBookings(res.bookings))
      .catch(() => setBookings('error'));
  }

  useEffect(() => {
    void fetchBookings();
    // Only on mount and on scope change — a text search is explicit
    // (Search button / Enter), not an auto-refetch on every keystroke.
  }, [scope]);

  function handleSearchSubmit(e: FormEvent) {
    e.preventDefault();
    fetchBookings();
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Cashier"
        description="Find a booking to bill, or open a new pre-arrival bill before the guest checks in."
        actions={
          <Button type="button" onClick={() => setShowNewForm((v) => !v)}>
            {showNewForm ? 'Cancel' : 'New pre-arrival booking'}
          </Button>
        }
      />

      {showNewForm && <NewPreArrivalBookingForm onCreated={() => setShowNewForm(false)} />}

      <Section title="Find a booking">
        <form onSubmit={handleSearchSubmit} className="flex flex-wrap items-end gap-3">
          <Field label="Guest name, booking ID, or billing number">
            <input className={INPUT_CLASSES} value={q} onChange={(e) => setQ(e.target.value)} />
          </Field>
          <Button type="submit" variant="secondary">
            Search
          </Button>
          {q && (
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setQ('');
                fetchBookings();
              }}
            >
              Clear
            </Button>
          )}
        </form>

        {!q && (
          <div className="flex gap-2">
            <Button type="button" variant={scope === 'in_house' ? 'primary' : 'secondary'} onClick={() => setScope('in_house')}>
              In-house
            </Button>
            <Button type="button" variant={scope === 'recent' ? 'primary' : 'secondary'} onClick={() => setScope('recent')}>
              Recently departed
            </Button>
          </div>
        )}

        {bookings === 'loading' && <p className="text-sm text-ink-secondary">Loading…</p>}
        {bookings === 'error' && <p role="alert">Could not load bookings.</p>}
        {Array.isArray(bookings) && bookings.length === 0 && <EmptyState message="No bookings found." />}
        {Array.isArray(bookings) && bookings.length > 0 && (
          <ul className="flex flex-col gap-2">
            {bookings.map((b) => (
              <li key={b.id}>
                <Link to={`/billing/${b.id}`} className="block rounded-lg border border-gray-200 p-3 hover:border-brand-300 hover:bg-brand-50">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-col">
                      <span className="text-sm font-semibold text-ink">{b.guestName}</span>
                      <span className="text-xs text-ink-secondary">
                        Booking ID {b.referenceNo} · {b.units.map((u) => u.code).join(', ') || 'No room yet'}
                      </span>
                    </div>
                    <StatusBadge variant={BOOKING_STATUS_BADGE_VARIANT[b.status]}>{BOOKING_STATUS_LABELS[b.status]}</StatusBadge>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

// Re-plan, spec.md §13 decision 16: billing before check-in — pick a
// READY unit, set check-in/check-out dates, and the booking exists (and
// can be billed) before the guest arrives. One unit per call,
// deliberately — a second room is CashierPage's own "add room" action
// on the billing page itself, once the booking exists.
function NewPreArrivalBookingForm({ onCreated }: { onCreated: () => void }) {
  const navigate = useNavigate();
  const [form, setForm] = useState(EMPTY_PRE_ARRIVAL_FORM);
  const [readyUnits, setReadyUnits] = useState<ReadyUnit[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ units: ReadyUnit[] }>('/units')
      .then((res) => setReadyUnits(res.units.filter((u) => u.status === 'READY' && isBookableUnitKind(u.type))))
      .catch(() => setReadyUnits([]));
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await api.post<{ booking: { id: string } }>('/bookings/pre-arrival', {
        guestName: form.guestName.trim(),
        externalBookingId: form.externalBookingId.trim(),
        checkInDate: form.checkInDate,
        checkOutDate: form.checkOutDate,
        unitId: form.unitId,
        notes: form.notes.trim() || undefined,
      });
      setForm(EMPTY_PRE_ARRIVAL_FORM);
      onCreated();
      navigate(`/billing/${res.booking.id}`);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not create the booking.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <h2 className="text-base font-semibold text-ink">New pre-arrival booking</h2>
        {error && (
          <p role="alert" className="text-sm font-medium text-danger-600">
            {error}
          </p>
        )}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Guest name">
            <input
              required
              className={INPUT_CLASSES}
              value={form.guestName}
              onChange={(e) => setForm((f) => ({ ...f, guestName: e.target.value }))}
            />
          </Field>
          <Field label="Booking ID (from the external booking website)">
            <input
              required
              className={INPUT_CLASSES}
              value={form.externalBookingId}
              onChange={(e) => setForm((f) => ({ ...f, externalBookingId: e.target.value }))}
            />
          </Field>
          <Field label="Check-in date">
            <input
              required
              type="date"
              className={INPUT_CLASSES}
              value={form.checkInDate}
              onChange={(e) => setForm((f) => ({ ...f, checkInDate: e.target.value }))}
            />
          </Field>
          <Field label="Check-out date">
            <input
              required
              type="date"
              className={INPUT_CLASSES}
              value={form.checkOutDate}
              onChange={(e) => setForm((f) => ({ ...f, checkOutDate: e.target.value }))}
            />
          </Field>
          <Field label="Room (Ready only)">
            <select
              required
              className={INPUT_CLASSES}
              value={form.unitId}
              onChange={(e) => setForm((f) => ({ ...f, unitId: e.target.value }))}
            >
              <option value="">Select…</option>
              {readyUnits.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.code} — {u.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Notes (optional)">
            <input className={INPUT_CLASSES} value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
          </Field>
        </div>
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Creating…' : 'Create booking'}
        </Button>
      </form>
    </Card>
  );
}
