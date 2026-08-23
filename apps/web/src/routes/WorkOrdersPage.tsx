import {
  DEFAULT_WORK_ORDER_PHOTO_REQUIREMENTS,
  DEPARTMENT_KEYS,
  WORK_ORDER_PRIORITY_KEYS,
  WORK_ORDER_TYPE_KEYS,
  type DepartmentKey,
  type WorkOrderPriorityKey,
  type WorkOrderStatusKey,
  type WorkOrderTypeKey,
} from '@lwwbr/shared';
import { useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import { useAuth } from '../context/AuthContext.js';
import { api, ApiRequestError } from '../lib/api.js';
import {
  DEPARTMENT_LABELS,
  WORK_ORDER_PRIORITY_LABELS,
  WORK_ORDER_STATUS_CLASSES,
  WORK_ORDER_STATUS_LABELS,
  WORK_ORDER_TYPE_LABELS,
} from '../lib/workOrderStyle.js';

interface WorkOrderRow {
  id: string;
  referenceNo: string;
  type: WorkOrderTypeKey;
  title: string;
  priority: WorkOrderPriorityKey;
  status: WorkOrderStatusKey;
  department: DepartmentKey;
  unit: { id: string; code: string; name: string } | null;
  assignedTo: { fullName: string } | null;
  createdAt: string;
}

interface UnitOption {
  id: string;
  code: string;
  name: string;
}

interface UploadedPhoto {
  fileId: string;
  filename: string;
}

const initialFormState = {
  type: 'HOUSEKEEPING' as WorkOrderTypeKey,
  title: '',
  description: '',
  priority: 'NORMAL' as WorkOrderPriorityKey,
  department: 'HOUSEKEEPING' as DepartmentKey,
  unitId: '',
  dueAt: '',
};

// Spec §7.2.1's requirements table, read from the shared default as a
// client-side UX hint only — the real gate is server-side (POST
// /work-orders reads the live workOrder.photoRequirements Setting and
// returns 422 PHOTO_REQUIRED regardless of what this page shows). This
// just tells the user up front which types need a photo, and — unlike a
// unit status button — the submit button below is never disabled by it:
// the request always actually fires, so a genuine gate mismatch (the
// live Setting loosened or tightened since this bundle was built) still
// surfaces as a real server error, not a silently-wrong client guess.
function requiresIssuePhoto(type: WorkOrderTypeKey): boolean {
  return DEFAULT_WORK_ORDER_PHOTO_REQUIREMENTS[type].onCreate.includes('ISSUE');
}

function NewWorkOrderForm({
  units,
  onCreated,
}: {
  units: UnitOption[];
  onCreated: (workOrder: WorkOrderRow) => void;
}) {
  const [form, setForm] = useState(initialFormState);
  const [photos, setPhotos] = useState<UploadedPhoto[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<{ message: string; kind?: string } | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  async function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setUploadError(null);
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const result = await api.upload<{ file: { id: string; filename: string } }>('/files', file);
        setPhotos((prev) => [...prev, { fileId: result.file.id, filename: result.file.filename }]);
      }
    } catch (err) {
      setUploadError(err instanceof ApiRequestError ? err.message : 'Could not upload photo.');
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  }

  function removePhoto(fileId: string) {
    setPhotos((prev) => prev.filter((p) => p.fileId !== fileId));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    setSuccessMessage(null);
    setSubmitting(true);
    try {
      const result = await api.post<{ workOrder: WorkOrderRow }>('/work-orders', {
        type: form.type,
        title: form.title.trim(),
        description: form.description.trim() || undefined,
        priority: form.priority,
        department: form.department,
        unitId: form.unitId || undefined,
        dueAt: form.dueAt ? new Date(form.dueAt).toISOString() : undefined,
        photos: photos.map((p) => ({ fileId: p.fileId, kind: 'ISSUE' as const })),
      });
      onCreated(result.workOrder);
      setSuccessMessage(`Created ${result.workOrder.referenceNo}.`);
      setForm(initialFormState);
      setPhotos([]);
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'PHOTO_REQUIRED') {
        const details = err.details as { kind?: string } | undefined;
        const kind = details?.kind ?? 'required';
        const article = /^[AEIOU]/.test(kind) ? 'An' : 'A';
        setSubmitError({
          message: `${article} ${kind} photo is required for this ticket type before it can be created.`,
          kind: details?.kind,
        });
      } else {
        setSubmitError({ message: err instanceof ApiRequestError ? err.message : 'Could not create ticket.' });
      }
    } finally {
      setSubmitting(false);
    }
  }

  const needsIssuePhoto = requiresIssuePhoto(form.type);

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-3 rounded border border-gray-200 p-4">
      <h2 className="text-sm font-semibold">New ticket</h2>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          Type
          <select
            className="rounded border border-gray-300 px-2 py-1"
            value={form.type}
            onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as WorkOrderTypeKey }))}
          >
            {WORK_ORDER_TYPE_KEYS.map((type) => (
              <option key={type} value={type}>
                {WORK_ORDER_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          Department
          <select
            className="rounded border border-gray-300 px-2 py-1"
            value={form.department}
            onChange={(e) => setForm((f) => ({ ...f, department: e.target.value as DepartmentKey }))}
          >
            {DEPARTMENT_KEYS.map((dept) => (
              <option key={dept} value={dept}>
                {DEPARTMENT_LABELS[dept]}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          Priority
          <select
            className="rounded border border-gray-300 px-2 py-1"
            value={form.priority}
            onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value as WorkOrderPriorityKey }))}
          >
            {WORK_ORDER_PRIORITY_KEYS.map((priority) => (
              <option key={priority} value={priority}>
                {WORK_ORDER_PRIORITY_LABELS[priority]}
              </option>
            ))}
          </select>
        </label>

        {units.length > 0 && (
          <label className="flex flex-col gap-1 text-sm">
            Related unit (optional)
            <select
              className="rounded border border-gray-300 px-2 py-1"
              value={form.unitId}
              onChange={(e) => setForm((f) => ({ ...f, unitId: e.target.value }))}
            >
              <option value="">None</option>
              {units.map((unit) => (
                <option key={unit.id} value={unit.id}>
                  {unit.code} — {unit.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <label className="flex flex-col gap-1 text-sm">
        Title
        <input
          required
          className="rounded border border-gray-300 px-2 py-1"
          value={form.title}
          onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        Description (optional)
        <textarea
          className="rounded border border-gray-300 px-2 py-1"
          rows={2}
          value={form.description}
          onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
        />
      </label>

      <div className="flex flex-col gap-2 rounded border border-gray-200 bg-gray-50 p-3">
        <p className="text-sm font-medium">
          Issue photos
          {needsIssuePhoto && <span className="ml-1 text-red-600">Required for {WORK_ORDER_TYPE_LABELS[form.type]}</span>}
          {!needsIssuePhoto && <span className="ml-1 text-xs font-normal text-gray-500">(optional for this type)</span>}
        </p>
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic"
          multiple
          disabled={uploading}
          onChange={(e) => void handleFileChange(e)}
        />
        {uploading && <p className="text-xs text-gray-500">Uploading…</p>}
        {uploadError && (
          <p role="alert" className="text-xs text-red-600">
            {uploadError}
          </p>
        )}
        {photos.length > 0 && (
          <ul className="flex flex-col gap-1">
            {photos.map((photo) => (
              <li key={photo.fileId} className="flex items-center justify-between text-xs text-gray-700">
                <span>{photo.filename}</span>
                <button type="button" onClick={() => removePhoto(photo.fileId)} className="text-red-600 hover:underline">
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {submitError && (
        <p role="alert" className="text-sm text-red-600">
          {submitError.message}
        </p>
      )}
      {successMessage && (
        <p role="status" className="text-sm text-green-700">
          {successMessage}
        </p>
      )}

      <button
        type="submit"
        disabled={submitting || uploading}
        className="w-fit rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {submitting ? 'Creating…' : 'Create ticket'}
      </button>
    </form>
  );
}

export function WorkOrdersPage() {
  const { user } = useAuth();
  const [workOrders, setWorkOrders] = useState<WorkOrderRow[] | 'loading' | 'error'>('loading');
  const [units, setUnits] = useState<UnitOption[]>([]);

  useEffect(() => {
    api
      .get<{ workOrders: WorkOrderRow[] }>('/work-orders')
      .then((res) => setWorkOrders(res.workOrders))
      .catch(() => setWorkOrders('error'));
    // Best-effort: not every role that can create a ticket also holds
    // unit:read (e.g. Restaurant Staff filing a GENERAL ticket) — if
    // this fails, the "Related unit" field just doesn't render rather
    // than blocking the whole page.
    api
      .get<{ units: UnitOption[] }>('/units')
      .then((res) => setUnits(res.units))
      .catch(() => setUnits([]));
  }, []);

  function handleCreated(workOrder: WorkOrderRow) {
    setWorkOrders((prev) => (Array.isArray(prev) ? [workOrder, ...prev] : [workOrder]));
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-lg font-semibold">Work Orders</h1>

      {user?.permissions['workorder:create'] && <NewWorkOrderForm units={units} onCreated={handleCreated} />}

      <section>
        <h2 className="mb-2 text-sm font-semibold text-gray-700">Tickets</h2>
        {workOrders === 'loading' && <p className="text-sm text-gray-500">Loading…</p>}
        {workOrders === 'error' && <p role="alert">Could not load work orders.</p>}
        {Array.isArray(workOrders) && workOrders.length === 0 && (
          <p className="text-sm text-gray-500">No tickets yet.</p>
        )}
        {Array.isArray(workOrders) && workOrders.length > 0 && (
          <ul className="flex flex-col gap-2">
            {workOrders.map((wo) => (
              <li key={wo.id} className="flex flex-wrap items-center gap-2 rounded border border-gray-200 p-3">
                <span
                  className={`rounded-full border px-2 py-0.5 text-xs font-medium ${WORK_ORDER_STATUS_CLASSES[wo.status]}`}
                >
                  {WORK_ORDER_STATUS_LABELS[wo.status]}
                </span>
                <span className="text-xs font-mono text-gray-500">{wo.referenceNo}</span>
                <span className="text-sm font-medium">{wo.title}</span>
                <span className="text-xs text-gray-500">
                  {WORK_ORDER_TYPE_LABELS[wo.type]} · {DEPARTMENT_LABELS[wo.department]} ·{' '}
                  {WORK_ORDER_PRIORITY_LABELS[wo.priority]}
                </span>
                {wo.unit && <span className="text-xs text-gray-500">Unit {wo.unit.code}</span>}
                {wo.assignedTo && <span className="text-xs text-gray-500">Assigned: {wo.assignedTo.fullName}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
