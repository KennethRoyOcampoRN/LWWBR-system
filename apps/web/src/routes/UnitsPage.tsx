import {
  allowedManualTransitions,
  allowedOverrideTransitions,
  UNIT_STATUS_KEYS,
  type UnitStatusKey,
} from '@lwwbr/shared';
import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext.js';
import { api, ApiRequestError } from '../lib/api.js';
import { UNIT_STATUS_CLASSES, UNIT_STATUS_LABELS } from '../lib/unitStatusStyle.js';

interface UnitRow {
  id: string;
  code: string;
  name: string;
  unitTypeId: string;
  type: string;
  capacity: number;
  floor: string | null;
  status: UnitStatusKey;
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

interface TimelineEvent {
  id: string;
  fromStatus: UnitStatusKey;
  toStatus: UnitStatusKey;
  note: string | null;
  createdAt: string;
  actor: { id: string; fullName: string; employeeCode: string };
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
  const [note, setNote] = useState('');
  const [changingTo, setChangingTo] = useState<UnitStatusKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forceToStatus, setForceToStatus] = useState<UnitStatusKey>(unit.status);
  const [forceNote, setForceNote] = useState('');
  const [forcing, setForcing] = useState(false);
  const [forceError, setForceError] = useState<string | null>(null);

  useEffect(() => {
    setTimeline('loading');
    api
      .get<{ events: TimelineEvent[] }>(`/units/${unit.id}/timeline`)
      .then((res) => setTimeline(res.events))
      .catch(() => setTimeline('error'));
  }, [unit.id]);

  const allowedNext = allowedManualTransitions(unit.status, user?.permissions ?? {});
  const overrideNext = allowedOverrideTransitions(unit.status, user?.roles ?? []);

  async function changeStatus(toStatus: UnitStatusKey) {
    setError(null);
    setChangingTo(toStatus);
    try {
      const trimmedNote = note.trim();
      const result = await api.post<{ id: string; status: UnitStatusKey; version: number }>(
        `/units/${unit.id}/status`,
        { toStatus, version: unit.version, note: trimmedNote || undefined },
      );
      onChanged({ ...unit, status: result.status, version: result.version, latestNote: trimmedNote || null });
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
    if (!forceNote.trim()) {
      setForceError('A note is required when forcing a status correction.');
      return;
    }
    setForcing(true);
    try {
      const trimmedNote = forceNote.trim();
      const result = await api.post<{ id: string; status: UnitStatusKey; version: number }>(
        `/units/${unit.id}/force-status`,
        { toStatus: forceToStatus, version: unit.version, note: trimmedNote },
      );
      onChanged({ ...unit, status: result.status, version: result.version, latestNote: trimmedNote });
      setForceNote('');
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'VERSION_CONFLICT') {
        setForceError('Someone else changed this unit — refresh the grid and try again.');
      } else {
        setForceError(err instanceof ApiRequestError ? err.message : 'Could not force the status correction.');
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
            These transitions normally happen automatically (inspection pass / booking check-in / check-out) —
            no inspection or booking module exists yet, so this is a manual stopgap. Every use is audited
            distinctly. Prefer waiting for the real flow once M3/M4 land.
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
            Jump this unit directly to any status to fix data staff forgot to update in real time. Distinct from
            "Change status" above — this skips the normal sequence entirely, so a note is required.
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
            placeholder="Note (required) — why is this being corrected?"
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

export function UnitsPage() {
  const [units, setUnits] = useState<UnitRow[] | 'loading' | 'error'>('loading');
  const [unitTypes, setUnitTypes] = useState<UnitTypeRow[]>([]);
  const [selectedUnitId, setSelectedUnitId] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      api.get<{ units: UnitRow[] }>('/units'),
      api.get<{ unitTypes: UnitTypeRow[] }>('/unit-types'),
    ])
      .then(([unitsRes, unitTypesRes]) => {
        setUnits(unitsRes.units);
        setUnitTypes(unitTypesRes.unitTypes);
      })
      .catch(() => setUnits('error'));
  }, []);

  function handleChanged(updated: UnitRow) {
    setUnits((prev) => (Array.isArray(prev) ? prev.map((u) => (u.id === updated.id ? updated : u)) : prev));
  }

  const unitTypeName = (id: string) => unitTypes.find((t) => t.id === id)?.name ?? 'Unknown type';
  const selectedUnit = Array.isArray(units) ? units.find((u) => u.id === selectedUnitId) : undefined;

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold">Units</h1>

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
