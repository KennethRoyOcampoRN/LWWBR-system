import {
  allowedManualTransitions,
  allowedOverrideTransitions,
  isBookableUnitKind,
  UNIT_KIND_GROUP_KEYS,
  UNIT_KIND_GROUP_LABELS,
  UNIT_KIND_KEYS,
  UNIT_KIND_LABELS,
  UNIT_STATUS_KEYS,
  unitKindGroup,
  type AnyUnitStatusKey,
  type BookingStatusKey,
  type UnitKindKey,
  type UnitStatusKey,
} from '@lwwbr/shared';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../components/Button.js';
import { Card, Section } from '../components/Card.js';
import { DataTable, type DataTableColumn } from '../components/DataTable.js';
import { EmptyState } from '../components/EmptyState.js';
import { Field, INPUT_CLASSES } from '../components/Field.js';
import { Skeleton, SkeletonCard, SkeletonList } from '../components/Skeleton.js';
import { StatusBadge } from '../components/StatusBadge.js';
import { useAuth } from '../context/AuthContext.js';
import { api, ApiRequestError } from '../lib/api.js';
import { BOOKING_STATUS_BADGE_VARIANT, BOOKING_STATUS_LABELS, BOOKING_TYPE_LABELS } from '../lib/bookingStyle.js';
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
  // Cashier-tab plan, Stage C (2026-11-05): booking id + guest name +
  // status on every occupied unit's own card — "the unit cards must
  // show booking ID and guest name" (client's own words), with status
  // the one field that tells a CONFIRMED (pre-arrival, room OCCUPIED
  // but nobody there yet) booking apart from an actual CHECKED_IN
  // guest, per decision 16's own mitigation for OCCUPIED-at-booking-time.
  currentBooking: { bookingId: string; referenceNo: string; guestName: string; status: BookingStatusKey } | null;
}

function formatPesoAmount(amount: number): string {
  return `₱${amount.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Caught live, 2026-11-18: UnitType.name has no uniqueness constraint
// (service layer rejects a new active duplicate going forward, but the
// client's own existing "Family Room" pair predates that and still
// exists) — anywhere a unit type is listed by name alone, two same-
// named rows are indistinguishable. Capacity and base rate tell them
// apart, per the client's own suggestion, so every such listing uses
// this instead of a bare name.
function unitTypeOptionLabel(t: UnitTypeRow): string {
  return `${t.name} — ${t.defaultCapacity} pax, ${formatPesoAmount(t.baseRate)}`;
}

// Setup Rooms (client-directed feature, 2026-11-04): expanded from the
// id/name shape the Check-in/Add-unit pickers only ever needed, to the
// full UnitType record the new management section below lists and edits.
// No photo field — client decision, 2026-11-05: item photos on UnitType
// are unnecessary (unlike AmenityItem/MenuItem, which keep theirs).
interface UnitTypeRow {
  id: string;
  name: string;
  description: string | null;
  defaultCapacity: number;
  baseRate: number;
  dayTourRate: number | null;
  extraPersonRate: number | null;
  colorHex: string | null;
  isActive: boolean;
  sortOrder: number;
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
  unitTypes,
  onClose,
  onChanged,
  onDeleted,
}: {
  unit: UnitRow;
  unitTypeName: string;
  unitTypes: UnitTypeRow[];
  onClose: () => void;
  onChanged: (unit: UnitRow) => void;
  onDeleted: () => void;
}) {
  const { user } = useAuth();
  const canManage = Boolean(user?.permissions['unit:manage']);
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

  // Real gap found live-testing, 2026-08-25: there was no UI to edit a
  // unit's own details at all — every field was stuck at whatever the
  // seed script created. Same start/cancel/submit-edit pattern as
  // AmenitiesPage.tsx's inline item edit; fields are captured into local
  // state on "Edit" rather than bound live to `unit` so a background
  // realtime status update while editing can't silently overwrite an
  // in-progress form value.
  const [editingUnit, setEditingUnit] = useState(false);
  const [editType, setEditType] = useState<UnitKindKey>(unit.type as UnitKindKey);
  const [editUnitTypeId, setEditUnitTypeId] = useState(unit.unitTypeId);
  const [editName, setEditName] = useState(unit.name);
  const [editCapacity, setEditCapacity] = useState(String(unit.capacity));
  const [editFloor, setEditFloor] = useState(unit.floor ?? '');
  const [editNotes, setEditNotes] = useState(unit.notes ?? '');
  const [editError, setEditError] = useState<string | null>(null);
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [activeError, setActiveError] = useState<string | null>(null);

  const startEditUnit = () => {
    setEditingUnit(true);
    setEditError(null);
    setEditType(unit.type as UnitKindKey);
    setEditUnitTypeId(unit.unitTypeId);
    setEditName(unit.name);
    setEditCapacity(String(unit.capacity));
    setEditFloor(unit.floor ?? '');
    setEditNotes(unit.notes ?? '');
  };
  const cancelEditUnit = () => setEditingUnit(false);

  const submitEditUnit = async (event: FormEvent) => {
    event.preventDefault();
    setEditError(null);
    setEditSubmitting(true);
    try {
      const res = await api.patch<{ unit: UnitRow }>(`/units/${unit.id}`, {
        name: editName,
        type: editType,
        unitTypeId: editUnitTypeId,
        capacity: Number(editCapacity),
        floor: editFloor.trim() || null,
        notes: editNotes.trim() || null,
      });
      onChanged({ ...unit, ...res.unit });
      setEditingUnit(false);
    } catch (err) {
      setEditError(err instanceof ApiRequestError ? err.message : 'Could not save the changes.');
    } finally {
      setEditSubmitting(false);
    }
  };

  const toggleUnitActive = async () => {
    setActiveError(null);
    try {
      const res = await api.patch<{ unit: UnitRow }>(`/units/${unit.id}`, { isActive: !unit.isActive });
      onChanged({ ...unit, ...res.unit });
    } catch (err) {
      setActiveError(err instanceof ApiRequestError ? err.message : 'Could not update the unit.');
    }
  };

  // Client decision, 2026-08-25: a real delete, but only for a unit with
  // zero real history ("I made a wrong room by mistake") — the server
  // refuses (409 UNIT_HAS_HISTORY) otherwise, directing the caller to
  // Deactivate instead, since a unit with real history (bookings, work
  // orders, status changes) would have that history corrupted by a real
  // delete. This button is also only offered once already deactivated,
  // same two-step guard as MenuItem/AmenityItem — the server's own 409
  // UNIT_STILL_ACTIVE is the real guard; this confirm dialog is a
  // second, client-side one on top of it.
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const deleteUnit = async () => {
    if (!window.confirm(`Permanently delete "${unit.code} — ${unit.name}"? This cannot be undone.`)) return;
    setDeleteError(null);
    setDeleting(true);
    try {
      await api.delete(`/units/${unit.id}`);
      onDeleted();
    } catch (err) {
      setDeleteError(err instanceof ApiRequestError ? err.message : 'Could not delete the unit.');
    } finally {
      setDeleting(false);
    }
  };

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

  // Spec.md §13 decision 18 (2026-11-06): warn but allow, not an
  // unconditional status flip. Same confirm-and-proceed shape
  // BillingPage.tsx already uses for DUPLICATE_BILLING_NUMBER — the
  // server computes and returns the outstanding balance in a 409, the
  // UI only asks the cashier to confirm it, never computes its own.
  async function confirmCheckOut(confirmOutstandingBalance = false) {
    setCheckOutSubmitting(true);
    setCheckOutError(null);
    try {
      await api.post('/bookings/checkout', { unitIds: checkOutSelectedUnitIds, confirmOutstandingBalance });
      setCheckOutChecklistBookingId(null);
      setCheckOutSelectedUnitIds([]);
      await fetchUpcomingBookings();
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'OUTSTANDING_BALANCE') {
        const proceed = window.confirm(`${err.message}\n\nClick OK to check out anyway.`);
        if (proceed) {
          setCheckOutSubmitting(false);
          await confirmCheckOut(true);
          return;
        }
        setCheckOutError(null);
      } else {
        setCheckOutError(err instanceof ApiRequestError ? err.message : 'Could not check out these rooms.');
      }
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
      {!unit.isActive && (
        <span className="inline-block w-fit rounded-full border border-gray-400 bg-gray-200 px-3 py-1 text-sm font-medium text-gray-800">
          Inactive
        </span>
      )}

      {canManage && (
        <div className="flex flex-col gap-2 rounded border border-gray-200 p-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">Unit details</p>
            <div className="flex gap-2">
              <button
                onClick={() => (editingUnit ? cancelEditUnit() : startEditUnit())}
                className="text-xs font-medium text-blue-700 hover:underline"
              >
                {editingUnit ? 'Close' : 'Edit'}
              </button>
              <button onClick={() => void toggleUnitActive()} className="text-xs font-medium text-blue-700 hover:underline">
                {unit.isActive ? 'Deactivate' : 'Reactivate'}
              </button>
              {/*
                Client decision, 2026-08-25: only offered once already
                inactive — matches the server's own 409 UNIT_STILL_ACTIVE
                guard, so this never fires a request that's certain to
                be refused. The server's separate 409 UNIT_HAS_HISTORY
                guard still applies underneath and surfaces via
                deleteError below.
              */}
              {!unit.isActive && (
                <button
                  onClick={() => void deleteUnit()}
                  disabled={deleting}
                  className="text-xs font-medium text-red-700 hover:underline disabled:opacity-50"
                >
                  {deleting ? 'Deleting…' : 'Delete'}
                </button>
              )}
            </div>
          </div>
          {activeError && (
            <p role="alert" className="text-xs text-red-600">
              {activeError}
            </p>
          )}
          {deleteError && (
            <p role="alert" className="text-xs text-red-600">
              {deleteError}
            </p>
          )}

          {editingUnit && (
            <form onSubmit={(e) => void submitEditUnit(e)} className="flex flex-col gap-2">
              {editError && (
                <p role="alert" className="text-xs text-red-600">
                  {editError}
                </p>
              )}
              <label className="flex flex-col gap-1 text-xs font-medium text-gray-600">
                Type
                <select
                  required
                  value={editType}
                  onChange={(e) => setEditType(e.target.value as UnitKindKey)}
                  className="rounded border border-gray-300 px-2 py-1 text-sm text-gray-900"
                >
                  {UNIT_KIND_GROUP_KEYS.map((group) => (
                    <optgroup key={group} label={UNIT_KIND_GROUP_LABELS[group]}>
                      {UNIT_KIND_KEYS.filter((kind) => unitKindGroup(kind) === group).map((kind) => (
                        <option key={kind} value={kind}>
                          {UNIT_KIND_LABELS[kind]}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-gray-600">
                Unit type
                <select
                  required
                  value={editUnitTypeId}
                  onChange={(e) => setEditUnitTypeId(e.target.value)}
                  className="rounded border border-gray-300 px-2 py-1 text-sm text-gray-900"
                >
                  {unitTypes.map((t) => (
                    <option key={t.id} value={t.id}>
                      {unitTypeOptionLabel(t)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-gray-600">
                Name
                <input
                  required
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="rounded border border-gray-300 px-2 py-1 text-sm text-gray-900"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-gray-600">
                Capacity
                <input
                  required
                  type="number"
                  min={1}
                  value={editCapacity}
                  onChange={(e) => setEditCapacity(e.target.value)}
                  className="rounded border border-gray-300 px-2 py-1 text-sm text-gray-900"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-gray-600">
                Floor (optional)
                <input
                  value={editFloor}
                  onChange={(e) => setEditFloor(e.target.value)}
                  className="rounded border border-gray-300 px-2 py-1 text-sm text-gray-900"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-gray-600">
                Notes (optional)
                <input
                  value={editNotes}
                  onChange={(e) => setEditNotes(e.target.value)}
                  className="rounded border border-gray-300 px-2 py-1 text-sm text-gray-900"
                />
              </label>
              <button
                type="submit"
                disabled={editSubmitting}
                className="w-fit rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              >
                {editSubmitting ? 'Saving…' : 'Save changes'}
              </button>
            </form>
          )}
        </div>
      )}

      {/* Deliberately separate from the status badge above and the
          Timeline below — a reservation, not a status. The live status
          color stays governed only by check-in/check-out, never by
          whether a booking exists. */}
      <div className="flex flex-col gap-1 rounded border border-gray-200 p-3">
        <p className="text-sm font-medium">Bookings</p>
        {upcomingBookings === 'loading' && <SkeletonList items={2} />}
        {upcomingBookings === 'error' && <p role="alert" className="text-sm text-red-600">Could not load bookings.</p>}
        {Array.isArray(upcomingBookings) && upcomingBookings.length === 0 && (
          <EmptyState message="No current or upcoming bookings for this unit." />
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

                  <div className="flex flex-wrap gap-2">
                    {canCheckOut && !showChecklist && (
                      <button
                        onClick={() => void openCheckOutChecklist(booking)}
                        className="w-fit rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
                      >
                        Check out
                      </button>
                    )}
                    {/* Build plan stage 4 (spec.md §13 decision 13,
                        2026-11-04): the entry point into billing — no
                        standalone "pick a booking" screen exists (and
                        wasn't asked for), so this is the one place a
                        cashier reaches a specific booking by id,
                        same as Check out above. Gated on receipt:issue,
                        not booking:checkout — a cashier who bills
                        doesn't necessarily check guests out. */}
                    {Boolean(user?.permissions['receipt:issue']) && (
                      <Link
                        to={`/billing/${booking.id}`}
                        className="w-fit rounded bg-brand-600 px-2 py-1 text-xs font-medium text-white hover:bg-brand-600/90"
                      >
                        Bill guest
                      </Link>
                    )}
                  </div>

                  {/* Checklist checkout, client decision 2026-08-24: "show
                      a checklist of all rooms tied to that same Booking
                      ID... let the user check/uncheck any combination."
                      Pre-checks this drawer's own unit; can span more
                      than one Booking row (a group checked in across
                      waves under the same external ID) since it's built
                      from GET /bookings/group, not this one row alone. */}
                  {showChecklist && (
                    <div className="flex flex-col gap-2 rounded border border-blue-300 bg-blue-50 p-2 text-xs text-blue-900">
                      {checkOutChecklist === 'loading' && <Skeleton className="h-4 w-32" />}
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
        {timeline === 'loading' && <SkeletonList />}
        {timeline === 'error' && <p role="alert">Could not load timeline.</p>}
        {Array.isArray(timeline) && timeline.length === 0 && <EmptyState message="No status changes recorded yet." />}
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

// Real bug found live-testing, 2026-08-25: the picker listed common
// areas (Beach Front, CR-Female/Male, Function Hall, Pool, Restaurant —
// COMMON_AREA/FACILITY) as selectable check-in destinations alongside
// real accommodations. Unlike isBookable above (a *temporary* live-state
// disable, still shown greyed out so the front desk understands why),
// this is a permanent category exclusion — a common area was never
// going to become a valid check-in target, so it's filtered out of the
// list entirely rather than shown disabled. The server carries the same
// rule independently (422 UNIT_NOT_BOOKABLE in checkInBooking).
function isGuestAccommodation(unit: UnitRow): boolean {
  return isBookableUnitKind(unit.type);
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
              (rooms/cottages only — common areas aren&apos;t listed; out-of-order/blocked/occupied ones are shown but
              cannot be selected)
            </span>
          </summary>
          <ul className="mt-2 flex flex-col gap-1">
            {units.filter(isGuestAccommodation).map((unit) => {
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

// Real gap found live-testing, 2026-08-25: there was no UI to add a unit
// at all — every unit was stuck at whatever the seed script created,
// despite spec §9/§10 always describing that data as placeholder pending
// a real admin UI. Type is the first field, client decision: choosing it
// determines which of the three groups (see UNIT_KIND_GROUP_LABELS) the
// new unit lands in — the <optgroup>s make that visible at the point of
// choice, not just in how the grid sorts it afterward.
function AddUnitForm({ unitTypes, onCreated }: { unitTypes: UnitTypeRow[]; onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<UnitKindKey>('ROOM');
  const [unitTypeId, setUnitTypeId] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [capacity, setCapacity] = useState('');
  const [floor, setFloor] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const resetForm = () => {
    setType('ROOM');
    setUnitTypeId('');
    setCode('');
    setName('');
    setCapacity('');
    setFloor('');
    setNotes('');
    setError(null);
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.post('/units', {
        code,
        name,
        type,
        unitTypeId,
        capacity: capacity ? Number(capacity) : undefined,
        floor: floor.trim() || undefined,
        notes: notes.trim() || undefined,
      });
      resetForm();
      setOpen(false);
      onCreated();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not add the unit.');
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-fit rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white"
      >
        + Add unit
      </button>
    );
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-3 rounded border border-gray-200 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-700">Add a unit</h2>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            resetForm();
          }}
          className="text-xs text-gray-500 hover:underline"
        >
          Close
        </button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs font-medium text-gray-600">
          Type
          <select
            required
            value={type}
            onChange={(e) => setType(e.target.value as UnitKindKey)}
            className="rounded border border-gray-300 px-2 py-1 text-sm"
          >
            {UNIT_KIND_GROUP_KEYS.map((group) => (
              <optgroup key={group} label={UNIT_KIND_GROUP_LABELS[group]}>
                {UNIT_KIND_KEYS.filter((kind) => unitKindGroup(kind) === group).map((kind) => (
                  <option key={kind} value={kind}>
                    {UNIT_KIND_LABELS[kind]}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-gray-600">
          Unit type (rate/capacity template)
          <select
            required
            value={unitTypeId}
            onChange={(e) => setUnitTypeId(e.target.value)}
            className="rounded border border-gray-300 px-2 py-1 text-sm"
          >
            <option value="" disabled>
              Select…
            </option>
            {unitTypes.map((t) => (
              <option key={t.id} value={t.id}>
                {unitTypeOptionLabel(t)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-gray-600">
          Code
          <input
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="e.g. R21"
            className="rounded border border-gray-300 px-2 py-1 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-gray-600">
          Name
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Room 21"
            className="rounded border border-gray-300 px-2 py-1 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-gray-600">
          Capacity (optional — defaults from unit type)
          <input
            type="number"
            min={1}
            value={capacity}
            onChange={(e) => setCapacity(e.target.value)}
            className="rounded border border-gray-300 px-2 py-1 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-gray-600">
          Floor (optional)
          <input
            value={floor}
            onChange={(e) => setFloor(e.target.value)}
            className="rounded border border-gray-300 px-2 py-1 text-sm"
          />
        </label>
      </div>
      <label className="flex flex-col gap-1 text-xs font-medium text-gray-600">
        Notes (optional)
        <input value={notes} onChange={(e) => setNotes(e.target.value)} className="rounded border border-gray-300 px-2 py-1 text-sm" />
      </label>
      <button
        type="submit"
        disabled={submitting}
        className="w-fit rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {submitting ? 'Adding…' : 'Add unit'}
      </button>
    </form>
  );
}

interface UnitTypeFormState {
  name: string;
  description: string;
  defaultCapacity: string;
  baseRate: string;
  dayTourRate: string;
  extraPersonRate: string;
  colorHex: string;
}

const EMPTY_UNIT_TYPE_FORM: UnitTypeFormState = {
  name: '',
  description: '',
  defaultCapacity: '2',
  baseRate: '',
  dayTourRate: '',
  extraPersonRate: '',
  colorHex: '',
};

function unitTypeFormToBody(form: UnitTypeFormState) {
  return {
    name: form.name.trim(),
    description: form.description.trim() || undefined,
    defaultCapacity: Number(form.defaultCapacity),
    baseRate: Number(form.baseRate),
    dayTourRate: form.dayTourRate.trim() === '' ? undefined : Number(form.dayTourRate),
    extraPersonRate: form.extraPersonRate.trim() === '' ? undefined : Number(form.extraPersonRate),
    colorHex: form.colorHex.trim() || undefined,
  };
}

// Setup Rooms (client-directed feature, 2026-11-04): POST/PATCH
// /unit-types already existed server-side (build plan stage/decision
// 13's predecessor work never needed them) but nothing in the web app
// ever called them — rooms were stuck on spec §10's seeded placeholder
// rates with no way to change them outside the database. Follows the
// same "management section on the page that already uses the catalog"
// convention as AmenitiesPage/FnbPage's own inline item-management
// forms, rather than a separate page or folding it into Resort Settings
// (which is scoped to resort identity/branding, a different concern).
// No photo field — client decision, 2026-11-05: item photos on UnitType
// are unnecessary (unlike AmenityItem/MenuItem, which keep theirs).
function SetupRoomsSection({ unitTypes, onSaved }: { unitTypes: UnitTypeRow[]; onSaved: () => void }) {
  const [addForm, setAddForm] = useState(EMPTY_UNIT_TYPE_FORM);
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState(EMPTY_UNIT_TYPE_FORM);
  const [editError, setEditError] = useState<string | null>(null);
  const [editSubmitting, setEditSubmitting] = useState(false);

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    setAddError(null);
    setAdding(true);
    try {
      await api.post('/unit-types', unitTypeFormToBody(addForm));
      setAddForm(EMPTY_UNIT_TYPE_FORM);
      onSaved();
    } catch (err) {
      setAddError(err instanceof ApiRequestError ? err.message : 'Could not add the room type.');
    } finally {
      setAdding(false);
    }
  }

  function startEdit(type: UnitTypeRow) {
    setEditingId(type.id);
    setEditForm({
      name: type.name,
      description: type.description ?? '',
      defaultCapacity: String(type.defaultCapacity),
      baseRate: String(type.baseRate),
      dayTourRate: type.dayTourRate === null ? '' : String(type.dayTourRate),
      extraPersonRate: type.extraPersonRate === null ? '' : String(type.extraPersonRate),
      colorHex: type.colorHex ?? '',
    });
    setEditError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditError(null);
  }

  async function submitEdit(e: FormEvent, id: string) {
    e.preventDefault();
    setEditError(null);
    setEditSubmitting(true);
    try {
      await api.patch(`/unit-types/${id}`, unitTypeFormToBody(editForm));
      setEditingId(null);
      onSaved();
    } catch (err) {
      setEditError(err instanceof ApiRequestError ? err.message : 'Could not save the room type.');
    } finally {
      setEditSubmitting(false);
    }
  }

  async function toggleActive(type: UnitTypeRow) {
    await api.patch(`/unit-types/${type.id}`, { isActive: !type.isActive });
    onSaved();
  }

  // Caught live, 2026-11-18: the client created a duplicate "Family
  // Room" by accident with no way to remove it — only Deactivate
  // existed. No reason prompt, same as deleting a never-receipted
  // folio charge — correcting a mistake, not a financial action. The
  // server 409s with the room count if any still use this type; that
  // message is shown plainly rather than guessed at client-side.
  const [deleteError, setDeleteError] = useState<string | null>(null);
  async function handleDelete(type: UnitTypeRow) {
    if (!window.confirm(`Delete "${type.name}"? This cannot be undone.`)) return;
    setDeleteError(null);
    try {
      await api.delete(`/unit-types/${type.id}`);
      onSaved();
    } catch (err) {
      setDeleteError(err instanceof ApiRequestError ? err.message : 'Could not delete this room type.');
    }
  }

  const columns: DataTableColumn<UnitTypeRow>[] = [
    { key: 'name', header: 'Name', render: (t) => <span className="font-medium">{t.name}</span> },
    { key: 'capacity', header: 'Capacity', render: (t) => t.defaultCapacity },
    { key: 'baseRate', header: 'Base rate', render: (t) => formatPesoAmount(t.baseRate) },
    { key: 'dayTourRate', header: 'Day tour', render: (t) => (t.dayTourRate === null ? '—' : formatPesoAmount(t.dayTourRate)) },
    {
      key: 'extraPersonRate',
      header: 'Extra person',
      render: (t) => (t.extraPersonRate === null ? '—' : formatPesoAmount(t.extraPersonRate)),
    },
    {
      key: 'status',
      header: 'Status',
      render: (t) => <StatusBadge variant={t.isActive ? 'success' : 'neutral'}>{t.isActive ? 'Active' : 'Inactive'}</StatusBadge>,
    },
    {
      key: 'actions',
      header: '',
      render: (t) => (
        <div className="flex gap-3">
          <button type="button" onClick={() => (editingId === t.id ? cancelEdit() : startEdit(t))} className="text-xs font-medium text-brand-700 hover:underline">
            {editingId === t.id ? 'Close' : 'Edit'}
          </button>
          <button type="button" onClick={() => void toggleActive(t)} className="text-xs font-medium text-brand-700 hover:underline">
            {t.isActive ? 'Deactivate' : 'Reactivate'}
          </button>
          <button type="button" onClick={() => void handleDelete(t)} className="text-xs font-medium text-danger-600 hover:underline">
            Delete
          </button>
        </div>
      ),
    },
  ];

  return (
    <Section title="Setup: Rooms" description="Room types and rates — printed and charged from here.">
      <div className="flex flex-col gap-4">
        {deleteError && (
          <p role="alert" className="text-sm font-medium text-danger-600">
            {deleteError}
          </p>
        )}
        <DataTable
          columns={columns}
          rows={unitTypes}
          rowKey={(t) => t.id}
          mobileTitle={(t) => t.name}
          emptyMessage="No room types yet."
        />

        {editingId && (
          <Card className="border border-gray-200">
            <form onSubmit={(e) => void submitEdit(e, editingId)} className="flex flex-col gap-4">
              {editError && <p role="alert" className="text-sm font-medium text-danger-600">{editError}</p>}
              <UnitTypeFormFields form={editForm} setForm={setEditForm} />
              <div className="flex gap-2">
                <Button type="submit" disabled={editSubmitting}>
                  {editSubmitting ? 'Saving…' : 'Save changes'}
                </Button>
                <Button type="button" variant="secondary" onClick={cancelEdit}>
                  Cancel
                </Button>
              </div>
            </form>
          </Card>
        )}

        <Card className="border border-gray-200">
          <form onSubmit={(e) => void handleAdd(e)} className="flex flex-col gap-4">
            <h3 className="text-sm font-semibold text-ink">Add a room type</h3>
            {addError && <p role="alert" className="text-sm font-medium text-danger-600">{addError}</p>}
            <UnitTypeFormFields form={addForm} setForm={setAddForm} />
            <Button type="submit" disabled={adding} className="w-fit">
              {adding ? 'Adding…' : 'Add room type'}
            </Button>
          </form>
        </Card>
      </div>
    </Section>
  );
}

function UnitTypeFormFields({
  form,
  setForm,
}: {
  form: UnitTypeFormState;
  setForm: (updater: (f: UnitTypeFormState) => UnitTypeFormState) => void;
}) {
  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Name">
          <input required className={INPUT_CLASSES} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
        </Field>
        <Field label="Default capacity">
          <input
            required
            type="number"
            min={1}
            className={INPUT_CLASSES}
            value={form.defaultCapacity}
            onChange={(e) => setForm((f) => ({ ...f, defaultCapacity: e.target.value }))}
          />
        </Field>
        <Field label="Base rate (₱)">
          <input
            required
            type="number"
            min={0}
            step="0.01"
            className={INPUT_CLASSES}
            value={form.baseRate}
            onChange={(e) => setForm((f) => ({ ...f, baseRate: e.target.value }))}
          />
        </Field>
        <Field label="Day tour rate (₱, optional)">
          <input
            type="number"
            min={0}
            step="0.01"
            className={INPUT_CLASSES}
            value={form.dayTourRate}
            onChange={(e) => setForm((f) => ({ ...f, dayTourRate: e.target.value }))}
          />
        </Field>
        <Field label="Extra person rate (₱, optional)">
          <input
            type="number"
            min={0}
            step="0.01"
            className={INPUT_CLASSES}
            value={form.extraPersonRate}
            onChange={(e) => setForm((f) => ({ ...f, extraPersonRate: e.target.value }))}
          />
        </Field>
        <Field label="Color (optional)">
          <input type="color" className={INPUT_CLASSES} value={form.colorHex || '#64748b'} onChange={(e) => setForm((f) => ({ ...f, colorHex: e.target.value }))} />
        </Field>
      </div>
      <Field label="Description (optional)">
        <textarea className={INPUT_CLASSES} value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
      </Field>
    </>
  );
}

// Spec.md §13 decision 29/30 (2026-11-15): named rate plans the cashier
// explicitly chooses at billing time, replacing the never-built date-
// range/weekday rule engine. This is the admin CRUD surface for it —
// Setup: Rates, alongside Setup: Rooms (RatePlansSection above), since
// that's where room pricing already lives.
interface RatePlanRateRow {
  id: string;
  unitTypeId: string;
  rate: number;
  unitType: { id: string; name: string };
}

interface RatePlanRow {
  id: string;
  name: string;
  startDate: string | null;
  endDate: string | null;
  weekdayMask: number | null;
  isActive: boolean;
  rates: RatePlanRateRow[];
}

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function weekdayMaskSummary(mask: number | null): string {
  if (mask === null) return '';
  const days = WEEKDAY_LABELS.filter((_, i) => ((mask >> i) & 1) === 1);
  if (days.length === 0) return '';
  return days.length === 7 ? 'every day' : days.join('/');
}

function dateRangeSummary(startDate: string | null, endDate: string | null): string {
  if (!startDate || !endDate) return '';
  const fmt = (d: string) => new Date(d).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', timeZone: 'Asia/Manila' });
  return `${fmt(startDate)}–${fmt(endDate)}`;
}

// Suggestion-only — see schema.prisma's own RatePlan comment. A plan
// with neither set (an "Off-season" catch-all) is never suggested over
// anything, only ever chosen explicitly, so this renders as "—" rather
// than an empty-looking blank.
function suggestionSummary(plan: RatePlanRow): string {
  const parts = [dateRangeSummary(plan.startDate, plan.endDate), weekdayMaskSummary(plan.weekdayMask)].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : '—';
}

const EMPTY_RATE_PLAN_FORM = { name: '', startDate: '', endDate: '', weekdays: new Set<number>() };

function RatePlansSection({
  unitTypes,
  units,
  onSaved,
}: {
  unitTypes: UnitTypeRow[];
  units: UnitRow[];
  onSaved: () => void;
}) {
  const [ratePlans, setRatePlans] = useState<RatePlanRow[] | 'loading' | 'error'>('loading');
  const [addForm, setAddForm] = useState(EMPTY_RATE_PLAN_FORM);
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // Single-open-editor pattern, same as SetupRoomsSection's own
  // editingId above — only one plan's rates are being edited at a time.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [rateDrafts, setRateDrafts] = useState<Record<string, string>>({});
  const [rateError, setRateError] = useState<string | null>(null);
  const [savingRateFor, setSavingRateFor] = useState<string | null>(null);

  const fetchRatePlans = useCallback(() => {
    return api
      .get<{ ratePlans: RatePlanRow[] }>('/rate-plans')
      .then((res) => setRatePlans(res.ratePlans))
      .catch(() => setRatePlans('error'));
  }, []);

  useEffect(() => {
    void fetchRatePlans();
  }, [fetchRatePlans]);

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    if (!addForm.name.trim()) return;
    setAddError(null);
    setAdding(true);
    try {
      const weekdayMask = addForm.weekdays.size > 0 ? [...addForm.weekdays].reduce((mask, day) => mask | (1 << day), 0) : undefined;
      await api.post('/rate-plans', {
        name: addForm.name.trim(),
        startDate: addForm.startDate || undefined,
        endDate: addForm.endDate || undefined,
        weekdayMask,
      });
      setAddForm(EMPTY_RATE_PLAN_FORM);
      void fetchRatePlans();
      onSaved();
    } catch (err) {
      setAddError(err instanceof ApiRequestError ? err.message : 'Could not create the rate plan.');
    } finally {
      setAdding(false);
    }
  }

  // Caught live, 2026-11-18: the client's own "WEEKDAYS" plan read
  // "0 / 6 room types" set — correct per the fail-loud design (any room
  // charged under it 422s RATE_PLAN_RATE_MISSING), but nothing warned
  // before activation, only after a cashier hit the gap. Scoped to
  // unit types that actually have a room assigned — a type with zero
  // rooms left unpriced doesn't matter operationally, so it shouldn't
  // block activating an otherwise-ready plan.
  async function toggleActive(plan: RatePlanRow) {
    const activating = !plan.isActive;
    if (activating) {
      const unitTypeIdsInUse = new Set(units.map((u) => u.unitTypeId));
      const uncoveredInUse = unitTypes.filter((ut) => unitTypeIdsInUse.has(ut.id) && !plan.rates.some((r) => r.unitTypeId === ut.id));
      if (uncoveredInUse.length > 0) {
        const names = uncoveredInUse.map((ut) => ut.name).join(', ');
        if (!window.confirm(`"${plan.name}" has no rate yet for: ${names}. A room of that type will fail to charge under this plan until one is set. Activate anyway?`)) {
          return;
        }
      }
    }
    await api.patch(`/rate-plans/${plan.id}`, { isActive: activating });
    void fetchRatePlans();
    onSaved();
  }

  async function handleDelete(plan: RatePlanRow) {
    if (!window.confirm(`Delete "${plan.name}"? This cannot be undone.`)) return;
    await api.delete(`/rate-plans/${plan.id}`);
    if (editingId === plan.id) setEditingId(null);
    void fetchRatePlans();
    onSaved();
  }

  function startEditingRates(plan: RatePlanRow) {
    setEditingId(plan.id);
    setRateError(null);
    const drafts: Record<string, string> = {};
    for (const ut of unitTypes) {
      const existing = plan.rates.find((r) => r.unitTypeId === ut.id);
      drafts[ut.id] = existing ? String(existing.rate) : '';
    }
    setRateDrafts(drafts);
  }

  async function saveRate(planId: string, unitTypeId: string) {
    const raw = rateDrafts[unitTypeId];
    const rate = Number(raw);
    if (!raw || !(rate >= 0)) {
      setRateError('Enter a non-negative rate before saving.');
      return;
    }
    setRateError(null);
    setSavingRateFor(unitTypeId);
    try {
      await api.put(`/rate-plans/${planId}/rates/${unitTypeId}`, { rate });
      void fetchRatePlans();
      onSaved();
    } catch (err) {
      setRateError(err instanceof ApiRequestError ? err.message : 'Could not save this rate.');
    } finally {
      setSavingRateFor(null);
    }
  }

  // Spec.md §13 decision 30: the client's own "fail loudly" requirement
  // lives at the pricing layer, not here — this is just what makes that
  // reachable from Setup. Confirmed, not silent: removing a rate takes
  // this room type out of what the plan can charge at all.
  async function clearRate(planId: string, unitTypeId: string) {
    if (!window.confirm('Remove this rate? This room type can no longer be charged under this plan until a rate is set again.')) return;
    await api.delete(`/rate-plans/${planId}/rates/${unitTypeId}`);
    setRateDrafts((d) => ({ ...d, [unitTypeId]: '' }));
    void fetchRatePlans();
    onSaved();
  }

  const columns: DataTableColumn<RatePlanRow>[] = [
    { key: 'name', header: 'Name', render: (p) => <span className="font-medium">{p.name}</span> },
    { key: 'suggest', header: 'Suggested for', render: (p) => suggestionSummary(p) },
    { key: 'coverage', header: 'Rates set', render: (p) => `${p.rates.length} / ${unitTypes.length} room types` },
    {
      key: 'status',
      header: 'Status',
      render: (p) => <StatusBadge variant={p.isActive ? 'success' : 'neutral'}>{p.isActive ? 'Active' : 'Inactive'}</StatusBadge>,
    },
    {
      key: 'actions',
      header: '',
      render: (p) => (
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => (editingId === p.id ? setEditingId(null) : startEditingRates(p))}
            className="text-xs font-medium text-brand-700 hover:underline"
          >
            {editingId === p.id ? 'Close' : 'Edit rates'}
          </button>
          <button type="button" onClick={() => void toggleActive(p)} className="text-xs font-medium text-brand-700 hover:underline">
            {p.isActive ? 'Deactivate' : 'Activate'}
          </button>
          <button type="button" onClick={() => void handleDelete(p)} className="text-xs font-medium text-danger-600 hover:underline">
            Delete
          </button>
        </div>
      ),
    },
  ];

  const editingPlan = Array.isArray(ratePlans) ? ratePlans.find((p) => p.id === editingId) : undefined;

  return (
    <Section title="Rate Plans" description='Named price lists the cashier chooses from at billing time — "Weekdays," "December Xmas," and so on.'>
      <div className="flex flex-col gap-4">
        {ratePlans === 'loading' && <SkeletonList items={3} />}
        {ratePlans === 'error' && <EmptyState message="Could not load rate plans." />}
        {Array.isArray(ratePlans) && (
          <DataTable columns={columns} rows={ratePlans} rowKey={(p) => p.id} mobileTitle={(p) => p.name} emptyMessage="No rate plans yet." />
        )}

        {editingPlan && (
          <Card className="border border-gray-200">
            <div className="flex flex-col gap-3">
              <h3 className="text-sm font-semibold text-ink">Rates for "{editingPlan.name}"</h3>
              {rateError && (
                <p role="alert" className="text-sm font-medium text-danger-600">
                  {rateError}
                </p>
              )}
              <div className="flex flex-col gap-2">
                {unitTypes.map((ut) => {
                  // Caught live, 2026-11-18: a room type with no rate
                  // under the selected plan 422s RATE_PLAN_RATE_MISSING
                  // at charge time — correct, but the setup screen
                  // should show the gap before a cashier hits it, not
                  // only let the count column imply one exists.
                  const isUnpriced = !editingPlan.rates.some((r) => r.unitTypeId === ut.id);
                  return (
                    <div key={ut.id} className="flex flex-wrap items-end gap-2">
                      <Field label={unitTypeOptionLabel(ut)}>
                        <input
                          type="number"
                          min={0}
                          step="0.01"
                          className={INPUT_CLASSES}
                          value={rateDrafts[ut.id] ?? ''}
                          onChange={(e) => setRateDrafts((d) => ({ ...d, [ut.id]: e.target.value }))}
                        />
                      </Field>
                      {isUnpriced && <span className="text-xs font-medium text-amber-700">No rate set</span>}
                      <Button type="button" variant="secondary" onClick={() => void saveRate(editingPlan.id, ut.id)} disabled={savingRateFor === ut.id}>
                        Save
                      </Button>
                      {!isUnpriced && (
                        <Button type="button" variant="secondary" onClick={() => void clearRate(editingPlan.id, ut.id)}>
                          Clear
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
              <Button type="button" variant="secondary" onClick={() => setEditingId(null)} className="w-fit">
                Done
              </Button>
            </div>
          </Card>
        )}

        <Card className="border border-gray-200">
          <form onSubmit={(e) => void handleAdd(e)} className="flex flex-col gap-4">
            <h3 className="text-sm font-semibold text-ink">Add a rate plan</h3>
            {addError && (
              <p role="alert" className="text-sm font-medium text-danger-600">
                {addError}
              </p>
            )}
            <Field label="Name">
              <input required className={INPUT_CLASSES} value={addForm.name} onChange={(e) => setAddForm((f) => ({ ...f, name: e.target.value }))} />
            </Field>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Suggest from (optional)">
                <input
                  type="date"
                  className={INPUT_CLASSES}
                  value={addForm.startDate}
                  onChange={(e) => setAddForm((f) => ({ ...f, startDate: e.target.value }))}
                />
              </Field>
              <Field label="Suggest to (optional)">
                <input
                  type="date"
                  className={INPUT_CLASSES}
                  value={addForm.endDate}
                  onChange={(e) => setAddForm((f) => ({ ...f, endDate: e.target.value }))}
                />
              </Field>
            </div>
            <Field label="Suggest on these weekdays (optional)">
              <div className="flex flex-wrap gap-3">
                {WEEKDAY_LABELS.map((label, day) => (
                  <label key={day} className="flex items-center gap-1 text-sm text-ink-secondary">
                    <input
                      type="checkbox"
                      checked={addForm.weekdays.has(day)}
                      onChange={(e) =>
                        setAddForm((f) => {
                          const weekdays = new Set(f.weekdays);
                          if (e.target.checked) weekdays.add(day);
                          else weekdays.delete(day);
                          return { ...f, weekdays };
                        })
                      }
                    />
                    {label}
                  </label>
                ))}
              </div>
            </Field>
            <Button type="submit" disabled={adding} className="w-fit">
              {adding ? 'Adding…' : 'Add rate plan'}
            </Button>
          </form>
        </Card>
      </div>
    </Section>
  );
}

// Spec.md §13 decision 34 (2026-11-18): bulk status change — the API's
// own BulkUnitStatusResult shape, duplicated here rather than imported
// since it's an API response type, not a shared domain type.
interface BulkUnitStatusResult {
  unitId: string;
  code: string | null;
  status: 'OK' | 'FAILED';
  message?: string;
}

export function UnitsPage() {
  const { user } = useAuth();
  const [units, setUnits] = useState<UnitRow[] | 'loading' | 'error'>('loading');
  const [unitTypes, setUnitTypes] = useState<UnitTypeRow[]>([]);
  const [selectedUnitId, setSelectedUnitId] = useState<string | null>(null);
  const [realtimeStatus, setRealtimeStatus] = useState<RealtimeConnectionStatus>('connecting');
  // Spec.md §13 decision 34: bulk status change selection + outcome.
  // bulkOutcome is keyed by unitId and persists on the grid (client
  // instruction: "report partial results where the person is looking...
  // visible on the grid, not in a panel they'd scroll to") until the
  // selection changes again or it's explicitly cleared.
  const [bulkSelectedIds, setBulkSelectedIds] = useState<Set<string>>(new Set());
  const [bulkTargetStatus, setBulkTargetStatus] = useState<UnitStatusKey | ''>('');
  const [bulkApplying, setBulkApplying] = useState(false);
  const [bulkOutcome, setBulkOutcome] = useState<Map<string, BulkUnitStatusResult> | null>(null);
  const [bulkSummary, setBulkSummary] = useState<string | null>(null);
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

  const fetchUnitTypes = useCallback(() => {
    return api.get<{ unitTypes: UnitTypeRow[] }>('/unit-types').then((res) => setUnitTypes(res.unitTypes));
  }, []);

  useEffect(() => {
    Promise.all([fetchUnits(), fetchUnitTypes()]).catch(() => setUnits('error'));
  }, [fetchUnits, fetchUnitTypes]);

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

  // Spec.md §13 decision 34: toggling, or picking a new "select all" set,
  // always drops the previous apply's on-grid outcome markers — client
  // instruction was that results stay visible until the next action, not
  // forever, and a changed selection is the clearest signal "the next
  // action" has started.
  function toggleBulkSelection(unitId: string) {
    setBulkOutcome(null);
    setBulkSummary(null);
    setBulkSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(unitId)) next.delete(unitId);
      else next.add(unitId);
      return next;
    });
  }

  function selectAllByStatus(status: AnyUnitStatusKey, unitIds: string[]) {
    setBulkOutcome(null);
    setBulkSummary(null);
    setBulkTargetStatus('');
    setBulkSelectedIds(new Set(unitIds));
  }

  function clearBulkSelection() {
    setBulkSelectedIds(new Set());
    setBulkTargetStatus('');
    setBulkOutcome(null);
    setBulkSummary(null);
  }

  async function handleBulkApply() {
    if (!bulkTargetStatus || bulkSelectedIds.size === 0) return;
    setBulkApplying(true);
    try {
      const result = await api.post<{
        results: BulkUnitStatusResult[];
        succeededCount: number;
        failedCount: number;
      }>('/units/bulk-status', {
        unitIds: Array.from(bulkSelectedIds),
        toStatus: bulkTargetStatus,
      });
      const outcome = new Map(result.results.map((r) => [r.unitId, r]));
      setBulkOutcome(outcome);
      setBulkSummary(
        result.failedCount === 0
          ? `All ${result.succeededCount} room${result.succeededCount === 1 ? '' : 's'} changed to ${UNIT_STATUS_LABELS[bulkTargetStatus]}.`
          : `${result.succeededCount} of ${result.results.length} room${result.results.length === 1 ? '' : 's'} changed to ${UNIT_STATUS_LABELS[bulkTargetStatus]}. ${result.failedCount} didn't — see below.`,
      );
      // Only the rooms that actually changed come off the selection — the
      // failed ones stay selected (and marked, per-card) so the person can
      // see exactly what to retry without re-picking them.
      setBulkSelectedIds(new Set(result.results.filter((r) => r.status === 'FAILED').map((r) => r.unitId)));
      setBulkTargetStatus('');
      void fetchUnits();
    } catch (err) {
      setBulkSummary(err instanceof ApiRequestError ? err.message : 'Could not change these rooms.');
    } finally {
      setBulkApplying(false);
    }
  }

  const unitTypeName = (id: string) => unitTypes.find((t) => t.id === id)?.name ?? 'Unknown type';
  const selectedUnit = Array.isArray(units)
    ? units.find((u) => u.id === selectedUnitId)
    : undefined;
  const showReconnecting = realtimeStatus === 'reconnecting' && hasConnectedOnce.current;
  const canManageUnits = Boolean(user?.permissions['unit:manage']);
  // Spec.md §13 decision 34: shown to anyone who could change at least
  // one status manually — same no-single-gate reasoning as the API route
  // (which permission applies depends on the transition requested), so
  // this mirrors the single-room drawer's own "render the controls, let
  // an empty allowed-list speak for itself" approach rather than hiding
  // the whole feature behind one permission.
  const canBulkStatus =
    Boolean(user?.permissions['unit:update_status']) ||
    Boolean(user?.permissions['unit:block']) ||
    Boolean(user?.permissions['unit:manage']);
  const unitList = Array.isArray(units) ? units : [];
  // Client refinement, 2026-11-18: "selecting by status is the actual
  // workflow, not select-all" — one-click "select all Dirty" etc, each
  // showing its own count, computed only from statuses actually present.
  const presentStatusCounts: Array<{ status: AnyUnitStatusKey; count: number; unitIds: string[] }> = [];
  for (const status of UNIT_STATUS_KEYS) {
    const matching = unitList.filter((u) => u.status === status);
    if (matching.length > 0) presentStatusCounts.push({ status, count: matching.length, unitIds: matching.map((u) => u.id) });
  }
  const bulkSelectedUnits = unitList.filter((u) => bulkSelectedIds.has(u.id));
  const bulkSelectedStatuses = Array.from(new Set(bulkSelectedUnits.map((u) => u.status)));
  // Intersection of allowedManualTransitions across every distinct status
  // in the selection — this is what guarantees OCCUPIED can never be
  // offered (it's reachable only via the automatic-trigger transition,
  // which allowedManualTransitions excludes by construction) and what
  // produces "no legal common target" rather than something that would
  // half-fail.
  let bulkCommonTargets: UnitStatusKey[] = [];
  if (bulkSelectedStatuses.length > 0) {
    bulkCommonTargets = bulkSelectedStatuses.every((s) => (UNIT_STATUS_KEYS as readonly string[]).includes(s))
      ? bulkSelectedStatuses.reduce<UnitStatusKey[] | null>((acc, status) => {
          const allowed = allowedManualTransitions(status as UnitStatusKey, user?.permissions ?? {});
          return acc === null ? allowed : acc.filter((t) => allowed.includes(t));
        }, null) ?? []
      : [];
  }
  const canManageUnitTypes = Boolean(user?.permissions['unittype:manage']);
  // Spec.md §13 decision 29/30 (2026-11-15): rateplan:manage, not
  // unittype:manage — a materially different, money-sensitive concern,
  // same reasoning as receipt:issue staying separate from folio:*.
  const canManageRatePlans = Boolean(user?.permissions['rateplan:manage']);

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

      {units === 'loading' && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          {Array.from({ length: 12 }, (_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      )}
      {units === 'error' && <p role="alert">Could not load units.</p>}

      {/* Spec.md §13 decision 34 (2026-11-18): bulk status change toolbar.
          Client refinement: "selecting by status is the actual workflow,
          not select-all" — thirteen Dirty rooms every morning, one click
          each to Cleaning then Ready. Each button is a full replace of
          the selection (not an add), and shows its own count. */}
      {canBulkStatus && Array.isArray(units) && units.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded border border-gray-200 bg-gray-50 p-2">
          <span className="text-xs font-medium text-gray-600">Select:</span>
          <Button
            type="button"
            variant="secondary"
            onClick={() => selectAllByStatus('VACANT_DIRTY', unitList.map((u) => u.id))}
          >
            All rooms ({unitList.length})
          </Button>
          {presentStatusCounts.map(({ status, count, unitIds }) => (
            <Button key={status} type="button" variant="secondary" onClick={() => selectAllByStatus(status, unitIds)}>
              Select all {UNIT_STATUS_LABELS[status]} ({count})
            </Button>
          ))}
        </div>
      )}

      {/* Action bar — appears once anything is selected, sits directly
          above the grid it acts on (not a side panel/modal) so the
          partial-result summary below lands exactly where the person is
          already looking, per the client's explicit "we've been caught
          by misplaced error states twice on the billing page." */}
      {canBulkStatus && bulkSelectedIds.size > 0 && (
        <div className="flex flex-col gap-2 rounded border border-brand-300 bg-brand-50 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{bulkSelectedIds.size} room{bulkSelectedIds.size === 1 ? '' : 's'} selected</span>
            {bulkCommonTargets.length > 0 ? (
              <select
                className={INPUT_CLASSES}
                value={bulkTargetStatus}
                onChange={(e) => setBulkTargetStatus(e.target.value as UnitStatusKey)}
                aria-label="Change selected rooms to"
              >
                <option value="">Change status to…</option>
                {bulkCommonTargets.map((status) => (
                  <option key={status} value={status}>
                    {UNIT_STATUS_LABELS[status]}
                  </option>
                ))}
              </select>
            ) : (
              // Client refinement: the empty-intersection case will happen
              // often (any mixed selection across statuses) — say *why*,
              // naming the statuses actually in the selection, rather than
              // just disabling the dropdown.
              <span role="alert" className="text-sm text-amber-800">
                No status is valid for every selected room — the selection mixes{' '}
                {bulkSelectedStatuses.map((s) => UNIT_STATUS_LABELS[s as UnitStatusKey] ?? s).join(', ')}. Select rooms
                with the same current status to change them together.
              </span>
            )}
            <Button type="button" onClick={() => void handleBulkApply()} disabled={!bulkTargetStatus || bulkApplying}>
              {bulkApplying ? 'Applying…' : 'Apply'}
            </Button>
            <Button type="button" variant="secondary" onClick={clearBulkSelection}>
              Clear
            </Button>
          </div>
          {bulkSummary && <p className="text-sm font-medium">{bulkSummary}</p>}
          {bulkOutcome && bulkOutcome.size > 0 && (
            <ul className="flex flex-col gap-0.5 text-xs text-gray-700">
              {Array.from(bulkOutcome.values())
                .filter((r) => r.status === 'FAILED')
                .map((r) => (
                  <li key={r.unitId} className="text-red-700">
                    {r.code ?? r.unitId}: {r.message ?? 'Could not change this room.'}
                  </li>
                ))}
            </ul>
          )}
        </div>
      )}

      {/* Client decision, 2026-08-25: three-way grouping — Rooms &
          Cottages / Common areas / Facilities — used here and in the
          Add-unit form's own Type field below. Facilities renders even
          while empty (spec's seeded common areas are all COMMON_AREA,
          confirmed against seed.ts — none are FACILITY today) so a
          future facility gets its own section automatically, no code
          change needed. */}
      {Array.isArray(units) &&
        UNIT_KIND_GROUP_KEYS.map((group) => {
          const groupUnits = units.filter((unit) => unitKindGroup(unit.type) === group);
          return (
            <div key={group} className="flex flex-col gap-2">
              <h2 className="text-sm font-semibold text-gray-700">
                {UNIT_KIND_GROUP_LABELS[group]} ({groupUnits.length})
              </h2>
              {groupUnits.length === 0 && <EmptyState message="None yet." />}
              {groupUnits.length > 0 && (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
                  {groupUnits.map((unit) => {
                    const outcome = bulkOutcome?.get(unit.id);
                    return (
                    <button
                      key={unit.id}
                      onClick={() => setSelectedUnitId(unit.id)}
                      className={`relative flex flex-col items-start gap-1 rounded border p-3 text-left ${UNIT_STATUS_CLASSES[unit.status]} ${unit.isActive ? '' : 'opacity-50'} ${outcome?.status === 'FAILED' ? 'ring-2 ring-danger-600' : ''} ${outcome?.status === 'OK' ? 'ring-2 ring-green-600' : ''}`}
                    >
                      {canBulkStatus && (
                        <input
                          type="checkbox"
                          aria-label={`Select room ${unit.code}`}
                          checked={bulkSelectedIds.has(unit.id)}
                          onClick={(e) => e.stopPropagation()}
                          onChange={() => toggleBulkSelection(unit.id)}
                          className="absolute left-1.5 top-1.5 h-4 w-4"
                        />
                      )}
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
                      {/* Per-card outcome marker — the client's "report
                          partial results where the person is looking"
                          refinement applied literally: each room that
                          just failed a bulk apply is flagged on its own
                          card, not only in the summary line above. */}
                      {outcome?.status === 'FAILED' && (
                        <span
                          role="img"
                          aria-label={`Could not change: ${outcome.message ?? 'unknown error'}`}
                          title={outcome.message ?? 'Could not change this room.'}
                          className="absolute bottom-1.5 right-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-danger-600 text-[10px] font-bold leading-none text-white"
                        >
                          !
                        </span>
                      )}
                      <span className="font-semibold">{unit.code}</span>
                      <span className="text-xs">{unit.name}</span>
                      <span className="text-xs font-medium">
                        {unit.isActive ? UNIT_STATUS_LABELS[unit.status] : 'Inactive'}
                      </span>
                      {/* Cashier-tab plan, Stage C (2026-11-05): the one
                          thing that keeps an OCCUPIED-at-booking-time
                          room (CONFIRMED, nobody there yet) from looking
                          identical to a room with a real guest in it —
                          decision 16's own stated mitigation for that
                          cost, finally wired up. */}
                      {unit.currentBooking && (
                        <span className="flex flex-col items-start gap-0.5 text-[11px] leading-tight text-ink-secondary">
                          <span className="font-medium text-ink">{unit.currentBooking.guestName}</span>
                          <span>Booking ID {unit.currentBooking.referenceNo}</span>
                          <StatusBadge variant={BOOKING_STATUS_BADGE_VARIANT[unit.currentBooking.status]}>
                            {BOOKING_STATUS_LABELS[unit.currentBooking.status]}
                          </StatusBadge>
                        </span>
                      )}
                    </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}

      {canManageUnits && <AddUnitForm unitTypes={unitTypes} onCreated={() => void fetchUnits()} />}

      {canManageUnitTypes && <SetupRoomsSection unitTypes={unitTypes} onSaved={() => void fetchUnitTypes()} />}

      {canManageRatePlans && (
        <RatePlansSection unitTypes={unitTypes} units={Array.isArray(units) ? units : []} onSaved={() => void fetchUnitTypes()} />
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
          unitTypes={unitTypes}
          onClose={() => setSelectedUnitId(null)}
          onChanged={handleChanged}
          onDeleted={() => {
            setSelectedUnitId(null);
            void fetchUnits();
          }}
        />
      )}
    </div>
  );
}
