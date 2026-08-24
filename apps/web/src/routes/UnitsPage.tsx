import {
  allowedManualTransitions,
  allowedOverrideTransitions,
  UNIT_STATUS_KEYS,
  type AnyUnitStatusKey,
  type UnitStatusKey,
} from '@lwwbr/shared';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useAuth } from '../context/AuthContext.js';
import { api, ApiRequestError } from '../lib/api.js';
import { BOOKING_TYPE_LABELS } from '../lib/bookingStyle.js';
import { subscribeToUnitStatusChanges, type RealtimeConnectionStatus } from '../lib/realtime.js';
import { UNIT_STATUS_CLASSES, UNIT_STATUS_LABELS } from '../lib/unitStatusStyle.js';

// Spec §3 resiliency rule (adapted from the Socket.IO-era "TanStack Query
// still polls every 60s as a fallback and refetches on window focus" —
// same principle, this app just doesn't use TanStack Query): a dropped
// realtime connection must never leave a stale board with no recovery
// path, so the grid also refetches on this interval regardless of
// whether the realtime channel is connected.
const UNITS_POLL_INTERVAL_MS = 60_000;

interface UnitRow {
  id: string;
  code: string;
  name: string;
  unitTypeId: string;
  type: string;
  capacity: number;
  floor: string | null;
  // AnyUnitStatusKey, not the forward-only UnitStatusKey: a live unit
  // can still legitimately be sitting at a retired status (INSPECTED,
  // retired 2026-08-22) until someone force-corrects it after this
  // deploy — the type says so honestly rather than lying about it.
  status: AnyUnitStatusKey;
  version: number;
  notes: string | null;
  isActive: boolean;
  // The note from whichever status-change panel (Change status, Admin
  // override, Force status correction) produced the unit's *current*
  // status — same display everywhere, no distinct treatment per panel.
  // Disappears the instant a later transition happens without a note, or
  // gets replaced if the new one has a note of its own.
  latestNote: string | null;
}

interface UnitTypeRow {
  id: string;
  name: string;
}

// Real gap found live-testing, 2026-08-23: bookings existed in complete
// isolation from the Units view. This is deliberately a separate concept
// from TimelineEvent below — a reservation, not a status transition —
// and never blended into the status badge or the Timeline list.
interface UpcomingBooking {
  id: string;
  referenceNo: string;
  guestName: string;
  type: 'OVERNIGHT' | 'DAY_TOUR';
  status: string;
  startAt: string;
  // Nullable, redesign 2026-08-24: Check-in never collects a departure
  // date, so a currently-CHECKED_IN stay has no known end until the
  // actual checkout moment fills this in.
  endAt: string | null;
}

// The checkout checklist's own row shape — GET /bookings/group?referenceNo=.
interface CheckOutCandidateUnit {
  unitId: string;
  code: string;
  name: string;
  bookingId: string;
  guestName: string;
}

interface TimelineEvent {
  id: string;
  // Always AnyUnitStatusKey: this is a historical record, and a past
  // event can genuinely reference the retired INSPECTED status forever.
  fromStatus: AnyUnitStatusKey;
  toStatus: AnyUnitStatusKey;
  note: string | null;
  createdAt: string;
  actor: { id: string; fullName: string; employeeCode: string };
}

// A retired status (INSPECTED) can't be pre-selected in the force-
// correction dropdown since it's no longer a valid target. Default to
// the unit's real status if it's still forward-valid, or to READY — the
// natural replacement for a unit stuck at the retired INSPECTED — if it
// isn't.
function defaultForceToStatus(status: AnyUnitStatusKey): UnitStatusKey {
  return (UNIT_STATUS_KEYS as readonly string[]).includes(status) ? (status as UnitStatusKey) : 'READY';
}

function UnitDetailDrawer({
  unit,
  unitTypeName,
  onClose,
  onChanged,
}: {
  unit: UnitRow;
  unitTypeName: string;
  onClose: () => void;
  onChanged: (unit: UnitRow) => void;
}) {
  const { user } = useAuth();
  const [timeline, setTimeline] = useState<TimelineEvent[] | 'loading' | 'error'>('loading');
  const [upcomingBookings, setUpcomingBookings] = useState<UpcomingBooking[] | 'loading' | 'error'>('loading');
  const [note, setNote] = useState('');
  const [changingTo, setChangingTo] = useState<UnitStatusKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forceToStatus, setForceToStatus] = useState<UnitStatusKey>(() => defaultForceToStatus(unit.status));
  const [forceNote, setForceNote] = useState('');
  const [forcing, setForcing] = useState(false);
  const [forceError, setForceError] = useState<string | null>(null);

  // Redesign, 2026-08-24 (live-testing feedback): check-in is no longer
  // an action performed *on* a row here — every guest already has a real
  // external booking, so there's no pre-existing PENDING reservation to
  // act on anymore. Check-in moved to its own panel below the grid (see
  // CheckInPanel, at the bottom of this file). Check-out stays, now as a
  // checklist rather than a binary prompt — "show a checklist of all
  // rooms tied to that same Booking ID... let the user check/uncheck any
  // combination," since a group's rooms can span more than one Booking
  // row (checked in across waves under the same external ID).
  const [checkOutChecklistBookingId, setCheckOutChecklistBookingId] = useState<string | null>(null);
  const [checkOutChecklist, setCheckOutChecklist] = useState<CheckOutCandidateUnit[] | 'loading' | 'error'>('loading');
  const [checkOutSelectedUnitIds, setCheckOutSelectedUnitIds] = useState<string[]>([]);
  const [checkOutSubmitting, setCheckOutSubmitting] = useState(false);
  const [checkOutError, setCheckOutError] = useState<string | null>(null);

  // Refetches on unit.id (opening a different unit) AND unit.version
  // (this same unit's status changed, from any source — clicking a
  // button in this very drawer, or a realtime broadcast from another
  // browser patching UnitsPage's `units` state, which flows down here as
  // a new `unit` prop with a bumped version). Without the version
  // dependency, the tile's colour/label updated live but this list sat
  // stale until the drawer was closed and reopened — real bug, reported
  // live 2026-08-23.
  useEffect(() => {
    setTimeline('loading');
    api
      .get<{ events: TimelineEvent[] }>(`/units/${unit.id}/timeline`)
      .then((res) => setTimeline(res.events))
      .catch(() => setTimeline('error'));
  }, [unit.id, unit.version]);

  const fetchUpcomingBookings = useCallback(() => {
    return api
      .get<{ bookings: UpcomingBooking[] }>(`/units/${unit.id}/bookings`)
      .then((res) => setUpcomingBookings(res.bookings))
      .catch(() => setUpcomingBookings((prev) => (Array.isArray(prev) ? prev : 'error')));
  }, [unit.id]);

  // unit.version is now a dependency too (redesign, 2026-08-24) — a
  // check-in/check-out from this exact drawer, but also one completed
  // from a different browser (another terminal's front desk) against
  // this same unit, bumps the unit's version via the real automatic
  // transition. Without it, this list could sit showing a booking as
  // still "Awaiting arrival" or "Checked in" after someone elsewhere
  // already acted on it — the same staleness bug Timeline's own
  // unit.version dependency above was added to fix.
  useEffect(() => {
    setUpcomingBookings('loading');
    void fetchUpcomingBookings();
  }, [unit.id, unit.version, fetchUpcomingBookings]);

  // Multi-room checkout as a checklist, client decision 2026-08-24: opens
  // the checklist for whichever units currently share this booking's
  // external ID and are still Occupied — pre-checks this drawer's own
  // unit, since that's the room the front desk actually clicked "Check
  // out" from.
  async function openCheckOutChecklist(booking: UpcomingBooking) {
    setCheckOutError(null);
    setCheckOutChecklistBookingId(booking.id);
    setCheckOutChecklist('loading');
    try {
      const res = await api.get<{ units: CheckOutCandidateUnit[] }>(
        `/bookings/group?referenceNo=${encodeURIComponent(booking.referenceNo)}`,
      );
      setCheckOutChecklist(res.units);
      setCheckOutSelectedUnitIds(res.units.some((u) => u.unitId === unit.id) ? [unit.id] : []);
    } catch {
      setCheckOutChecklist('error');
    }
  }

  function toggleCheckOutUnit(unitId: string) {
    setCheckOutSelectedUnitIds((prev) => (prev.includes(unitId) ? prev.filter((id) => id !== unitId) : [...prev, unitId]));
  }

  function cancelCheckOutChecklist() {
    setCheckOutChecklistBookingId(null);
    setCheckOutSelectedUnitIds([]);
    setCheckOutError(null);
  }

  async function confirmCheckOut() {
    setCheckOutSubmitting(true);
    setCheckOutError(null);
    try {
      await api.post('/bookings/checkout', { unitIds: checkOutSelectedUnitIds });
      setCheckOutChecklistBookingId(null);
      setCheckOutSelectedUnitIds([]);
      await fetchUpcomingBookings();
    } catch (err) {
      setCheckOutError(err instanceof ApiRequestError ? err.message : 'Could not check out these rooms.');
    } finally {
      setCheckOutSubmitting(false);
    }
  }

  // Both functions defensively return [] for a retired/unknown `from`
  // status rather than throwing (see unitStatus.ts) — the cast here is
  // safe even for a live unit still stuck at the retired INSPECTED.
  const allowedNext = allowedManualTransitions(unit.status as UnitStatusKey, user?.permissions ?? {});
  const overrideNext = allowedOverrideTransitions(unit.status as UnitStatusKey, user?.roles ?? []);

  async function changeStatus(toStatus: UnitStatusKey) {
    setError(null);
    setChangingTo(toStatus);
    try {
      const trimmedNote = note.trim();
      const result = await api.post<{ id: string; status: UnitStatusKey; version: number }>(
        `/units/${unit.id}/status`,
        { toStatus, version: unit.version, note: trimmedNote || undefined },
      );
      onChanged({
        ...unit,
        status: result.status,
        version: result.version,
        latestNote: trimmedNote || null,
      });
      setNote('');
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'VERSION_CONFLICT') {
        setError('Someone else changed this unit — refresh the grid and try again.');
      } else {
        setError(err instanceof ApiRequestError ? err.message : 'Could not change status.');
      }
    } finally {
      setChangingTo(null);
    }
  }

  async function forceStatusCorrection() {
    setForceError(null);
    setForcing(true);
    try {
      const trimmedNote = forceNote.trim();
      const result = await api.post<{ id: string; status: UnitStatusKey; version: number }>(
        `/units/${unit.id}/force-status`,
        { toStatus: forceToStatus, version: unit.version, note: trimmedNote || undefined },
      );
      onChanged({
        ...unit,
        status: result.status,
        version: result.version,
        latestNote: trimmedNote || null,
      });
      setForceNote('');
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'VERSION_CONFLICT') {
        setForceError('Someone else changed this unit — refresh the grid and try again.');
      } else {
        setForceError(
          err instanceof ApiRequestError ? err.message : 'Could not force the status correction.',
        );
      }
    } finally {
      setForcing(false);
    }
  }

  return (
    <div className="fixed inset-y-0 right-0 z-10 flex w-full max-w-sm flex-col gap-4 overflow-y-auto border-l border-gray-200 bg-white p-4 shadow-lg">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold">
            {unit.code} — {unit.name}
          </h2>
          <p className="text-sm text-gray-500">
            {unitTypeName} · Capacity {unit.capacity}
            {unit.floor ? ` · Floor ${unit.floor}` : ''}
          </p>
        </div>
        <button onClick={onClose} className="text-sm text-gray-500 hover:underline">
          Close
        </button>
      </div>

      <span
        className={`inline-block w-fit rounded-full border px-3 py-1 text-sm font-medium ${UNIT_STATUS_CLASSES[unit.status]}`}
      >
        {UNIT_STATUS_LABELS[unit.status]}
      </span>

      {/* Deliberately separate from the status badge above and the
          Timeline below — a reservation, not a status. The live status
          color stays governed only by check-in/check-out, never by
          whether a booking exists. */}
      <div className="flex flex-col gap-1 rounded border border-gray-200 p-3">
        <p className="text-sm font-medium">Bookings</p>
        {upcomingBookings === 'loading' && <p className="text-sm text-gray-500">Loading…</p>}
        {upcomingBookings === 'error' && <p role="alert" className="text-sm text-red-600">Could not load bookings.</p>}
        {Array.isArray(upcomingBookings) && upcomingBookings.length === 0 && (
          <p className="text-sm text-gray-500">No current or upcoming bookings for this unit.</p>
        )}
        {Array.isArray(upcomingBookings) && upcomingBookings.length > 0 && (
          <ul className="flex flex-col gap-2">
            {upcomingBookings.map((booking) => {
              // Redesign, 2026-08-24: check-in is gone from this list —
              // every guest already has a real external booking, so
              // there's never a pre-existing PENDING row to act on here
              // anymore (see CheckInPanel below the grid instead). Only
              // checkout remains a row-level action, gated on the
              // permission the same way the Verify button is hidden from
              // a cross-department POC.
              //
              // Keyed off unit.status (this drawer's own room), not
              // booking.status — real gap found live-testing 2026-08-24:
              // a booking checked in through the old, now-removed "New
              // booking" flow may never have completed its own
              // transition to CHECKED_IN before that flow was deleted,
              // permanently hiding this button for a room that's
              // genuinely still Occupied. The room's own live status is
              // the actual fact that matters here; the booking's
              // bookkeeping status doesn't affect whether the room needs
              // to be checked out. GET /units/:id/bookings already
              // excludes CANCELLED/CHECKED_OUT bookings server-side, so
              // anything reaching this list is a valid checkout target
              // once the room itself is Occupied.
              const canCheckOut = Boolean(user?.permissions['booking:checkout']) && unit.status === 'OCCUPIED';
              const showChecklist = checkOutChecklistBookingId === booking.id;
              return (
                <li key={booking.id} className="flex flex-col gap-1 text-sm">
                  <div>
                    Booked: {booking.guestName},{' '}
                    {new Date(booking.startAt).toLocaleDateString('en-PH', { timeZone: 'Asia/Manila' })}
                    {booking.endAt
                      ? ` – ${new Date(booking.endAt).toLocaleDateString('en-PH', { timeZone: 'Asia/Manila' })}`
                      : ''}
                    , ref {booking.referenceNo}
                    <span className="ml-1 text-xs text-gray-500">
                      ({BOOKING_TYPE_LABELS[booking.type]})
                    </span>
                  </div>

                  {canCheckOut && !showChecklist && (
                    <button
                      onClick={() => void openCheckOutChecklist(booking)}
                      className="w-fit rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
                    >
                      Check out
                    </button>
                  )}

                  {/* Checklist checkout, client decision 2026-08-24: "show
                      a checklist of all rooms tied to that same Booking
                      ID... let the user check/uncheck any combination."
                      Pre-checks this drawer's own unit; can span more
                      than one Booking row (a group checked in across
                      waves under the same external ID) since it's built
                      from GET /bookings/group, not this one row alone. */}
                  {showChecklist && (
                    <div className="flex flex-col gap-2 rounded border border-blue-300 bg-blue-50 p-2 text-xs text-blue-900">
                      {checkOutChecklist === 'loading' && <p>Loading rooms…</p>}
                      {checkOutChecklist === 'error' && (
                        <p role="alert" className="text-red-700">
                          Could not load the rooms for this booking.
                        </p>
                      )}
                      {Array.isArray(checkOutChecklist) && (
                        <>
                          <p className="font-medium">
                            {checkOutChecklist.length > 1
                              ? `${checkOutChecklist.length} rooms are on Booking ID ${booking.referenceNo} — pick which to check out:`
                              : 'Confirm check-out:'}
                          </p>
                          <ul className="flex flex-col gap-1">
                            {checkOutChecklist.map((candidate) => (
                              <li key={candidate.unitId}>
                                <label className="flex items-center gap-2">
                                  <input
                                    type="checkbox"
                                    checked={checkOutSelectedUnitIds.includes(candidate.unitId)}
                                    onChange={() => toggleCheckOutUnit(candidate.unitId)}
                                  />
                                  {candidate.code} — {candidate.name}
                                  {candidate.guestName !== booking.guestName ? ` (${candidate.guestName})` : ''}
                                </label>
                              </li>
                            ))}
                          </ul>
                        </>
                      )}
                      <div className="flex flex-wrap gap-2">
                        <button
                          onClick={() => void confirmCheckOut()}
                          disabled={checkOutSubmitting || checkOutSelectedUnitIds.length === 0}
                          className="rounded bg-blue-600 px-2 py-1 font-medium text-white disabled:opacity-50"
                        >
                          {checkOutSubmitting
                            ? 'Checking out…'
                            : `Check out ${checkOutSelectedUnitIds.length || ''} room${checkOutSelectedUnitIds.length === 1 ? '' : 's'}`}
                        </button>
                        <button
                          onClick={cancelCheckOutChecklist}
                          disabled={checkOutSubmitting}
                          className="text-blue-700 hover:underline disabled:opacity-50"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {checkOutError && (
          <p role="alert" className="text-xs text-red-600">
            {checkOutError}
          </p>
        )}
      </div>

      {allowedNext.length > 0 && (
        <div className="flex flex-col gap-2 rounded border border-gray-200 p-3">
          <p className="text-sm font-medium">Change status</p>
          <input
            className="rounded border border-gray-300 px-2 py-1 text-sm"
            placeholder="Optional note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            {allowedNext.map((status) => (
              <button
                key={status}
                onClick={() => void changeStatus(status)}
                disabled={changingTo !== null}
                className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              >
                {changingTo === status ? 'Saving…' : `Mark ${UNIT_STATUS_LABELS[status]}`}
              </button>
            ))}
          </div>
        </div>
      )}

      {overrideNext.length > 0 && (
        <div className="flex flex-col gap-2 rounded border border-amber-300 bg-amber-50 p-3">
          <p className="text-sm font-medium text-amber-900">Admin override</p>
          <p className="text-xs text-amber-800">
            These transitions normally happen automatically via check-in/check-out — this is a
            manual stopgap for when that real flow can't be used (stale data, testing). Every use is
            audited distinctly. Prefer the real check-in/check-out flow when it's available.
          </p>
          <div className="flex flex-wrap gap-2">
            {overrideNext.map((status) => (
              <button
                key={status}
                onClick={() => void changeStatus(status)}
                disabled={changingTo !== null}
                className="rounded border border-amber-600 bg-amber-100 px-3 py-1.5 text-sm font-medium text-amber-900 disabled:opacity-50"
              >
                {changingTo === status ? 'Saving…' : `Override → ${UNIT_STATUS_LABELS[status]}`}
              </button>
            ))}
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}

      {user?.permissions['unit:force_status'] && (
        <div className="flex flex-col gap-2 rounded border-2 border-dashed border-rose-300 bg-rose-50 p-3">
          <p className="text-sm font-medium text-rose-900">Force status correction</p>
          <p className="text-xs text-rose-800">
            Jump this unit directly to any status to fix data staff forgot to update in real time.
            Distinct from "Change status" above — this skips the normal sequence entirely.
          </p>
          <label className="flex flex-col gap-1 text-xs text-rose-900">
            Correct status to
            <select
              className="rounded border border-rose-300 px-2 py-1 text-sm text-gray-900"
              value={forceToStatus}
              onChange={(e) => setForceToStatus(e.target.value as UnitStatusKey)}
            >
              {UNIT_STATUS_KEYS.map((status) => (
                <option key={status} value={status}>
                  {UNIT_STATUS_LABELS[status]}
                </option>
              ))}
            </select>
          </label>
          <input
            className="rounded border border-rose-300 px-2 py-1 text-sm"
            placeholder="Optional note — why is this being corrected?"
            value={forceNote}
            onChange={(e) => setForceNote(e.target.value)}
          />
          {forceError && (
            <p role="alert" className="text-xs text-rose-700">
              {forceError}
            </p>
          )}
          <button
            onClick={() => void forceStatusCorrection()}
            disabled={forcing}
            className="w-fit rounded border border-rose-600 bg-rose-100 px-3 py-1.5 text-sm font-medium text-rose-900 disabled:opacity-50"
          >
            {forcing ? 'Saving…' : 'Force correction'}
          </button>
        </div>
      )}

      <div>
        <p className="mb-2 text-sm font-medium">Timeline</p>
        {timeline === 'loading' && <p className="text-sm text-gray-500">Loading…</p>}
        {timeline === 'error' && <p role="alert">Could not load timeline.</p>}
        {Array.isArray(timeline) && timeline.length === 0 && (
          <p className="text-sm text-gray-500">No status changes recorded yet.</p>
        )}
        {Array.isArray(timeline) && (
          <ul className="flex flex-col gap-2">
            {timeline.map((event) => (
              <li key={event.id} className="border-l-2 border-gray-200 pl-3 text-sm">
                <p>
                  {UNIT_STATUS_LABELS[event.fromStatus]} → {UNIT_STATUS_LABELS[event.toStatus]}
                </p>
                <p className="text-xs text-gray-500">
                  {event.actor.fullName} · {new Date(event.createdAt).toLocaleString()}
                </p>
                {event.note && <p className="text-xs text-gray-600">"{event.note}"</p>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// Spec §7.5: "A unit that is OUT_OF_ORDER or BLOCKED cannot be assigned
// at all" — pre-filtered client-side so the front desk never even tries
// to pick one, though the server enforces the same rule regardless.
// Reused from the old "New booking" form's own picker — same live-
// status-aware checklist, just without the rate/pricing fields.
//
// OCCUPIED added 2026-08-24 — real bug found live-testing: the picker
// disabled BLOCKED/OUT_OF_ORDER but left an already-Occupied room fully
// selectable, risking a double-booking of a room that already has a
// guest in it. The server's own hard block (409 UNIT_UNAVAILABLE)
// already rejects this regardless — this is the same "never even try"
// UX treatment as the other two, not a new rule.
function isBookable(unit: UnitRow): boolean {
  return unit.isActive && unit.status !== 'OUT_OF_ORDER' && unit.status !== 'BLOCKED' && unit.status !== 'OCCUPIED';
}

// "YYYY-MM-DD" for today in Asia/Manila, as a default for the date
// picker — 'en-CA' formats a plain date as ISO order, no locale parsing
// needed to build the string back up.
function todayInManila(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
}

// New feature, 2026-08-24 (client decision, live-testing feedback):
// "this app's job is monitoring the resort's current, live state, not
// managing reservations... every guest ... already arrives with a real
// external booking ID." Replaces the old Bookings-page reservation form
// entirely — this both creates the Booking record and moves the
// selected room(s) to OCCUPIED in one action, deliberately just the four
// fields asked for. Gated on booking:checkin by the caller (UnitsPage
// below), same as every other permission-gated panel in this app.
function CheckInPanel({ units, onCheckedIn }: { units: UnitRow[]; onCheckedIn: () => void }) {
  const [guestName, setGuestName] = useState('');
  const [externalBookingId, setExternalBookingId] = useState('');
  const [checkInDate, setCheckInDate] = useState(todayInManila);
  const [selectedUnitIds, setSelectedUnitIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [notReadyWarning, setNotReadyWarning] = useState<{ unitCode: string; unitStatus: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  function toggleUnit(id: string) {
    setSelectedUnitIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function submit(acknowledgeNotReady: boolean) {
    setSubmitting(true);
    setError(null);
    try {
      await api.post('/bookings/checkin', {
        guestName: guestName.trim(),
        externalBookingId: externalBookingId.trim(),
        checkInDate,
        units: selectedUnitIds.map((unitId) => ({ unitId })),
        acknowledgeNotReady,
      });
      setSuccess(`${guestName.trim()} checked in — Booking ID ${externalBookingId.trim()}.`);
      setNotReadyWarning(null);
      setGuestName('');
      setExternalBookingId('');
      setCheckInDate(todayInManila());
      setSelectedUnitIds([]);
      onCheckedIn();
    } catch (err) {
      // Spec §7.5: "A unit that simply isn't READY yet at check-in raises
      // a warning the front desk acknowledges rather than a hard block."
      // First attempt omits acknowledgeNotReady; a 409 UNIT_NOT_READY
      // shows the warning, and "Check in anyway" resubmits with it true.
      if (err instanceof ApiRequestError && err.code === 'UNIT_NOT_READY') {
        const details = err.details as { unitCode?: string; unitStatus?: string } | undefined;
        setNotReadyWarning({ unitCode: details?.unitCode ?? 'The unit', unitStatus: details?.unitStatus ?? 'not ready' });
      } else {
        setError(err instanceof ApiRequestError ? err.message : 'Could not check in this guest.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    if (selectedUnitIds.length === 0) {
      setError('Select at least one room.');
      return;
    }
    await submit(false);
  }

  const selectedCount = selectedUnitIds.length;

  return (
    // Compact/vertical layout, 2026-08-24 (UI refinement) — roughly 1/3
    // page width rather than full-width, fields stacked top to bottom
    // (Booking ID, Guest name, Check-in date, then Rooms collapsed behind
    // a <details> the way "Report an issue" already collapses on Work
    // Orders) instead of the previous 3-column spread with an always-open
    // ~23-room checklist. Layout/sizing only — every behavior below
    // (live status per room, disabled states, not-ready warning) is
    // unchanged.
    <div className="flex w-full flex-col gap-3 rounded border border-blue-300 bg-blue-50 p-4 md:w-1/3">
      <h2 className="text-sm font-semibold">Check-in</h2>
      <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          Booking ID
          <input
            required
            className="rounded border border-gray-300 px-2 py-1"
            value={externalBookingId}
            onChange={(e) => setExternalBookingId(e.target.value)}
            placeholder="from the resort's booking website"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Guest name
          <input
            required
            className="rounded border border-gray-300 px-2 py-1"
            value={guestName}
            onChange={(e) => setGuestName(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Check-in date
          <input
            required
            type="date"
            className="rounded border border-gray-300 px-2 py-1"
            value={checkInDate}
            onChange={(e) => setCheckInDate(e.target.value)}
          />
        </label>

        <details className="rounded border border-gray-200 bg-white p-3">
          <summary className="cursor-pointer text-sm font-medium">
            Rooms
            {selectedCount > 0 ? ` (${selectedCount} selected)` : ''}
            <span className="ml-1 text-xs font-normal text-gray-500">
              (out-of-order/blocked/occupied rooms are shown but cannot be selected)
            </span>
          </summary>
          <ul className="mt-2 flex flex-col gap-1">
            {units.map((unit) => {
              const bookable = isBookable(unit);
              const checked = selectedUnitIds.includes(unit.id);
              return (
                <li key={unit.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <label className={`flex items-center gap-2 ${bookable ? '' : 'opacity-50'}`}>
                    <input type="checkbox" disabled={!bookable} checked={checked} onChange={() => toggleUnit(unit.id)} />
                    {unit.code} — {unit.name}
                  </label>
                  <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${UNIT_STATUS_CLASSES[unit.status]}`}>
                    {UNIT_STATUS_LABELS[unit.status]}
                  </span>
                </li>
              );
            })}
          </ul>
        </details>

        {notReadyWarning && (
          <div role="alert" className="flex flex-col gap-2 rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900">
            <p>
              {notReadyWarning.unitCode} is not Ready yet (currently{' '}
              {UNIT_STATUS_LABELS[notReadyWarning.unitStatus as AnyUnitStatusKey] ?? notReadyWarning.unitStatus}). Spec §7.5:
              real check-ins happen while the room is still being finished — this is a warning, not a hard block.
            </p>
            <button
              onClick={() => void submit(true)}
              disabled={submitting}
              className="w-fit rounded border border-amber-600 bg-amber-100 px-3 py-1.5 text-sm font-medium text-amber-900 disabled:opacity-50"
            >
              {submitting ? 'Checking in…' : 'Check in anyway'}
            </button>
          </div>
        )}

        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
        {success && (
          <p role="status" className="text-sm font-medium text-green-800">
            {success}
          </p>
        )}

        {!notReadyWarning && (
          <button
            type="submit"
            disabled={submitting}
            className="w-fit rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {submitting ? 'Checking in…' : 'Check in'}
          </button>
        )}
      </form>
    </div>
  );
}

export function UnitsPage() {
  const { user } = useAuth();
  const [units, setUnits] = useState<UnitRow[] | 'loading' | 'error'>('loading');
  const [unitTypes, setUnitTypes] = useState<UnitTypeRow[]>([]);
  const [selectedUnitId, setSelectedUnitId] = useState<string | null>(null);
  const [realtimeStatus, setRealtimeStatus] = useState<RealtimeConnectionStatus>('connecting');
  // Tracks whether the realtime channel has ever reached 'connected', so
  // the reconnecting banner only shows for an actual drop, not for the
  // brief 'connecting' state every page load starts in.
  const hasConnectedOnce = useRef(false);

  const fetchUnits = useCallback(() => {
    return api
      .get<{ units: UnitRow[] }>('/units')
      .then((res) => setUnits(res.units))
      .catch(() => setUnits((prev) => (Array.isArray(prev) ? prev : 'error')));
  }, []);

  useEffect(() => {
    Promise.all([
      fetchUnits(),
      api
        .get<{ unitTypes: UnitTypeRow[] }>('/unit-types')
        .then((res) => setUnitTypes(res.unitTypes)),
    ]).catch(() => setUnits('error'));
  }, [fetchUnits]);

  // Fallback recovery path (spec §3): a 60s poll and a window-focus
  // refetch, independent of whether the realtime channel below is
  // currently connected — the grid can never get permanently stale just
  // because a socket dropped and didn't come back.
  useEffect(() => {
    const interval = setInterval(() => void fetchUnits(), UNITS_POLL_INTERVAL_MS);
    const onFocus = () => void fetchUnits();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, [fetchUnits]);

  // Live updates: every open Units page reflects a status change from
  // any of the three panels (normal, override, forced correction) as
  // soon as it's broadcast — spec §11's "a status change in one browser
  // appears in another within 2s without refresh."
  useEffect(() => {
    const unsubscribe = subscribeToUnitStatusChanges(
      (payload) => {
        setUnits((prev) => {
          if (!Array.isArray(prev)) return prev;
          return prev.map((u) => {
            if (u.id !== payload.entityId || payload.version <= u.version) {
              return u;
            }
            return {
              ...u,
              status: payload.toStatus as UnitStatusKey,
              version: payload.version,
              latestNote: payload.note,
            };
          });
        });
      },
      (status) => {
        if (status === 'connected') hasConnectedOnce.current = true;
        setRealtimeStatus(status);
      },
    );
    return unsubscribe;
  }, []);

  function handleChanged(updated: UnitRow) {
    setUnits((prev) =>
      Array.isArray(prev) ? prev.map((u) => (u.id === updated.id ? updated : u)) : prev,
    );
  }

  const unitTypeName = (id: string) => unitTypes.find((t) => t.id === id)?.name ?? 'Unknown type';
  const selectedUnit = Array.isArray(units)
    ? units.find((u) => u.id === selectedUnitId)
    : undefined;
  const showReconnecting = realtimeStatus === 'reconnecting' && hasConnectedOnce.current;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <h1 className="text-lg font-semibold">Units</h1>
        {showReconnecting && (
          <span
            role="status"
            className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800"
          >
            Reconnecting…
          </span>
        )}
      </div>

      {units === 'loading' && <p className="text-sm text-gray-500">Loading…</p>}
      {units === 'error' && <p role="alert">Could not load units.</p>}

      {Array.isArray(units) && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          {units.map((unit) => (
            <button
              key={unit.id}
              onClick={() => setSelectedUnitId(unit.id)}
              className={`relative flex flex-col items-start gap-1 rounded border p-3 text-left ${UNIT_STATUS_CLASSES[unit.status]}`}
            >
              {unit.latestNote && (
                <span
                  role="img"
                  aria-label={`Note: ${unit.latestNote}`}
                  title={`Note: ${unit.latestNote}`}
                  tabIndex={0}
                  className="absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-gray-700 text-[10px] font-bold leading-none text-white"
                >
                  i
                </span>
              )}
              <span className="font-semibold">{unit.code}</span>
              <span className="text-xs">{unit.name}</span>
              <span className="text-xs font-medium">{UNIT_STATUS_LABELS[unit.status]}</span>
            </button>
          ))}
        </div>
      )}

      {/* New feature, 2026-08-24: check-in as a quick-action below the
          grid, gated on booking:checkin — same pattern as the Verify
          button being hidden from a cross-department POC, so roles
          without it (housekeeping, maintenance) see no clutter. */}
      {Boolean(user?.permissions['booking:checkin']) && Array.isArray(units) && (
        <CheckInPanel units={units} onCheckedIn={() => void fetchUnits()} />
      )}

      {selectedUnit && (
        <UnitDetailDrawer
          unit={selectedUnit}
          unitTypeName={unitTypeName(selectedUnit.unitTypeId)}
          onClose={() => setSelectedUnitId(null)}
          onChanged={handleChanged}
        />
      )}
    </div>
  );
}
