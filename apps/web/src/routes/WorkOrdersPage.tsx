import {
  allowedWorkOrderTransitions,
  canVerifyWorkOrder,
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
import { useAuth, type CurrentUser } from '../context/AuthContext.js';
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

interface WorkOrderPhotoView {
  id: string;
  kind: 'ISSUE' | 'PROGRESS' | 'COMPLETION';
  caption: string | null;
  capturedAt: string;
  attemptNo: number;
  url: string;
}

interface WorkOrderNoteView {
  id: string;
  body: string;
  createdAt: string;
  author: { fullName: string };
}

interface WorkOrderDetail extends WorkOrderRow {
  description: string | null;
  version: number;
  dueAt: string | null;
  attemptNo: number;
  createdBy: { id: string; fullName: string };
  assignedTo: { id: string; fullName: string } | null;
  photos: WorkOrderPhotoView[];
  notes: WorkOrderNoteView[];
}

interface AssignableUser {
  id: string;
  fullName: string;
  employeeCode: string;
  department: DepartmentKey;
}

const PHOTO_KIND_LABELS: Record<WorkOrderPhotoView['kind'], string> = {
  ISSUE: 'Issue',
  PROGRESS: 'Progress',
  COMPLETION: 'Completion',
};

function requiresCompletionPhoto(type: WorkOrderTypeKey): boolean {
  return DEFAULT_WORK_ORDER_PHOTO_REQUIREMENTS[type].onDone.includes('COMPLETION');
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

function WorkOrderDetailDrawer({
  id,
  onClose,
  onChanged,
}: {
  id: string;
  onClose: () => void;
  onChanged: (workOrder: WorkOrderRow) => void;
}) {
  const { user } = useAuth();
  const [workOrder, setWorkOrder] = useState<WorkOrderDetail | 'loading' | 'error'>('loading');

  const [pendingTransition, setPendingTransition] = useState<WorkOrderStatusKey | null>(null);
  const [transitionNote, setTransitionNote] = useState('');
  const [transitionPhotos, setTransitionPhotos] = useState<UploadedPhoto[]>([]);
  const [transitionUploading, setTransitionUploading] = useState(false);
  const [transitionSubmitting, setTransitionSubmitting] = useState(false);
  const [transitionError, setTransitionError] = useState<{ message: string; kind?: string } | null>(null);

  const [assigning, setAssigning] = useState(false);
  const [assignableUsers, setAssignableUsers] = useState<AssignableUser[] | 'loading' | 'error'>('loading');
  const [selectedAssignee, setSelectedAssignee] = useState('');
  const [assignSubmitting, setAssignSubmitting] = useState(false);
  const [assignError, setAssignError] = useState<string | null>(null);

  useEffect(() => {
    setWorkOrder('loading');
    api
      .get<{ workOrder: WorkOrderDetail }>(`/work-orders/${id}`)
      .then((res) => setWorkOrder(res.workOrder))
      .catch(() => setWorkOrder('error'));
  }, [id]);

  function resetTransitionForm() {
    setPendingTransition(null);
    setTransitionNote('');
    setTransitionPhotos([]);
    setTransitionError(null);
  }

  async function handleTransitionFileChange(e: ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setTransitionUploading(true);
    try {
      for (const file of Array.from(files)) {
        const result = await api.upload<{ file: { id: string; filename: string } }>('/files', file);
        setTransitionPhotos((prev) => [...prev, { fileId: result.file.id, filename: result.file.filename }]);
      }
    } catch (err) {
      setTransitionError({ message: err instanceof ApiRequestError ? err.message : 'Could not upload photo.' });
    } finally {
      setTransitionUploading(false);
      e.target.value = '';
    }
  }

  async function confirmTransition() {
    if (!pendingTransition || workOrder === 'loading' || workOrder === 'error') return;
    setTransitionSubmitting(true);
    setTransitionError(null);
    try {
      const trimmedNote = transitionNote.trim();
      const result = await api.post<{ workOrder: WorkOrderDetail }>(`/work-orders/${id}/status`, {
        toStatus: pendingTransition,
        version: workOrder.version,
        note: trimmedNote || undefined,
        photos:
          pendingTransition === 'DONE' ? transitionPhotos.map((p) => ({ fileId: p.fileId, kind: 'COMPLETION' as const })) : [],
      });
      setWorkOrder(result.workOrder);
      onChanged(result.workOrder);
      resetTransitionForm();
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'VERSION_CONFLICT') {
        setTransitionError({ message: 'Someone else changed this ticket — close and reopen it, then try again.' });
      } else if (err instanceof ApiRequestError && err.code === 'PHOTO_REQUIRED') {
        const details = err.details as { kind?: string } | undefined;
        const kind = details?.kind ?? 'required';
        const article = /^[AEIOU]/.test(kind) ? 'An' : 'A';
        setTransitionError({ message: `${article} ${kind} photo is required to mark this ticket done.`, kind: details?.kind });
      } else {
        setTransitionError({ message: err instanceof ApiRequestError ? err.message : 'Could not update this ticket.' });
      }
    } finally {
      setTransitionSubmitting(false);
    }
  }

  // Deliberately property-wide, not scoped to the ticket's own
  // department — staff routinely get assigned to work outside their own
  // department (client decision, 2026-08-23), so this lists every active
  // employee, not just the ticket's department.
  function openAssignPicker() {
    if (workOrder === 'loading' || workOrder === 'error') return;
    setAssigning(true);
    setAssignableUsers('loading');
    setAssignError(null);
    api
      .get<{ users: AssignableUser[] }>('/work-orders/assignable-users')
      .then((res) => setAssignableUsers(res.users))
      .catch(() => setAssignableUsers('error'));
  }

  async function confirmAssign() {
    if (workOrder === 'loading' || workOrder === 'error' || !selectedAssignee) return;
    setAssignSubmitting(true);
    setAssignError(null);
    try {
      const result = await api.post<{ workOrder: WorkOrderDetail }>(`/work-orders/${id}/assign`, {
        assignedToId: selectedAssignee,
        version: workOrder.version,
      });
      setWorkOrder(result.workOrder);
      onChanged(result.workOrder);
      setAssigning(false);
      setSelectedAssignee('');
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'VERSION_CONFLICT') {
        setAssignError('Someone else changed this ticket — close and reopen it, then try again.');
      } else {
        setAssignError(err instanceof ApiRequestError ? err.message : 'Could not assign this ticket.');
      }
    } finally {
      setAssignSubmitting(false);
    }
  }

  if (workOrder === 'loading') {
    return (
      <div className="fixed inset-y-0 right-0 z-10 flex w-full max-w-md flex-col gap-4 overflow-y-auto border-l border-gray-200 bg-white p-4 shadow-lg">
        <p className="text-sm text-gray-500">Loading…</p>
      </div>
    );
  }
  if (workOrder === 'error') {
    return (
      <div className="fixed inset-y-0 right-0 z-10 flex w-full max-w-md flex-col gap-4 overflow-y-auto border-l border-gray-200 bg-white p-4 shadow-lg">
        <p role="alert">Could not load this ticket.</p>
        <button onClick={onClose} className="w-fit text-sm text-gray-500 hover:underline">
          Close
        </button>
      </div>
    );
  }

  // allowedWorkOrderTransitions only checks resource-permission (§7:
  // packages/shared's single source of truth). Two further client-side
  // filters on top of that raw list:
  // - ASSIGNED is excluded entirely — OPEN -> ASSIGNED is real in the
  //   shared transition table (so the *permission* check stays correct),
  //   but assigning a ticket needs an assignedToId the generic
  //   note-only status-change panel below has no field for. That real
  //   assignment flow — picking a person, calling POST
  //   /work-orders/:id/assign — is the dedicated `canAssign` section
  //   further down; without this filter its "Mark Assigned" fallback
  //   button would open the wrong (assignee-less) panel and silently do
  //   nothing useful. See canAssign below for the actual assign UI.
  // - VERIFIED/REOPENED get canVerifyWorkOrder's department-match rule
  //   applied, purely so a cross-department POC never sees a button
  //   that would 403 — the server enforces the same rule regardless.
  const candidateTransitions = allowedWorkOrderTransitions(workOrder.status, user?.permissions ?? {});
  const allowedTransitions = candidateTransitions.filter((to) => {
    if (to === 'ASSIGNED') return false;
    if (to !== 'VERIFIED' && to !== 'REOPENED') return true;
    return canVerifyWorkOrder(user?.roles ?? [], user?.department ?? '', workOrder.department);
  });
  const canAssign = workOrder.status === 'OPEN' && Boolean(user?.permissions['workorder:assign']);
  const needsCompletionPhoto = pendingTransition === 'DONE' && requiresCompletionPhoto(workOrder.type);

  const TRANSITION_BUTTON_LABELS: Partial<Record<WorkOrderStatusKey, string>> = {
    IN_PROGRESS: 'Start',
    DONE: 'Mark done',
    VERIFIED: 'Verify',
    REOPENED: 'Reopen (QC fail)',
    CANCELLED: 'Cancel ticket',
  };

  return (
    <div className="fixed inset-y-0 right-0 z-10 flex w-full max-w-md flex-col gap-4 overflow-y-auto border-l border-gray-200 bg-white p-4 shadow-lg">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold">{workOrder.title}</h2>
          <p className="text-xs font-mono text-gray-500">{workOrder.referenceNo}</p>
        </div>
        <button onClick={onClose} className="text-sm text-gray-500 hover:underline">
          Close
        </button>
      </div>

      <span
        className={`inline-block w-fit rounded-full border px-3 py-1 text-sm font-medium ${WORK_ORDER_STATUS_CLASSES[workOrder.status]}`}
      >
        {WORK_ORDER_STATUS_LABELS[workOrder.status]}
        {workOrder.attemptNo > 1 ? ` · attempt ${workOrder.attemptNo}` : ''}
      </span>

      <div className="grid grid-cols-2 gap-2 text-sm">
        <div>
          <p className="text-xs text-gray-500">Type</p>
          <p>{WORK_ORDER_TYPE_LABELS[workOrder.type]}</p>
        </div>
        <div>
          <p className="text-xs text-gray-500">Priority</p>
          <p>{WORK_ORDER_PRIORITY_LABELS[workOrder.priority]}</p>
        </div>
        <div>
          <p className="text-xs text-gray-500">Department</p>
          <p>{DEPARTMENT_LABELS[workOrder.department]}</p>
        </div>
        <div>
          <p className="text-xs text-gray-500">Assigned to</p>
          <p>{workOrder.assignedTo?.fullName ?? 'Unassigned'}</p>
        </div>
        {workOrder.unit && (
          <div>
            <p className="text-xs text-gray-500">Unit</p>
            <p>
              {workOrder.unit.code} — {workOrder.unit.name}
            </p>
          </div>
        )}
        <div>
          <p className="text-xs text-gray-500">Created by</p>
          <p>{workOrder.createdBy.fullName}</p>
        </div>
      </div>

      {workOrder.description && (
        <div>
          <p className="text-xs text-gray-500">Description</p>
          <p className="whitespace-pre-wrap text-sm">{workOrder.description}</p>
        </div>
      )}

      <div>
        <p className="mb-1 text-xs text-gray-500">Photos</p>
        {workOrder.photos.length === 0 && <p className="text-sm text-gray-500">No photos attached.</p>}
        {workOrder.photos.length > 0 && (
          <div className="grid grid-cols-2 gap-2">
            {workOrder.photos.map((photo) => (
              <a key={photo.id} href={photo.url} target="_blank" rel="noreferrer" className="flex flex-col gap-1">
                <img src={photo.url} alt={photo.caption ?? PHOTO_KIND_LABELS[photo.kind]} className="h-24 w-full rounded border border-gray-200 object-cover" />
                <span className="text-xs text-gray-500">
                  {PHOTO_KIND_LABELS[photo.kind]}
                  {photo.attemptNo > 1 ? ` · attempt ${photo.attemptNo}` : ''}
                </span>
              </a>
            ))}
          </div>
        )}
      </div>

      {workOrder.notes.length > 0 && (
        <div>
          <p className="mb-1 text-xs text-gray-500">Notes</p>
          <ul className="flex flex-col gap-2">
            {workOrder.notes.map((n) => (
              <li key={n.id} className="rounded border border-gray-200 p-2 text-sm">
                <p className="whitespace-pre-wrap">{n.body}</p>
                <p className="mt-1 text-xs text-gray-500">{n.author.fullName}</p>
              </li>
            ))}
          </ul>
        </div>
      )}

      {canAssign && (
        <div className="flex flex-col gap-2 rounded border border-gray-200 p-3">
          <p className="text-sm font-medium">Assign</p>
          {!assigning && (
            <button
              onClick={openAssignPicker}
              className="w-fit rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white"
            >
              Assign ticket
            </button>
          )}
          {assigning && (
            <>
              {assignableUsers === 'loading' && <p className="text-xs text-gray-500">Loading staff…</p>}
              {assignableUsers === 'error' && <p role="alert" className="text-xs text-red-600">Could not load staff.</p>}
              {Array.isArray(assignableUsers) && (
                <select
                  className="rounded border border-gray-300 px-2 py-1 text-sm"
                  value={selectedAssignee}
                  onChange={(e) => setSelectedAssignee(e.target.value)}
                >
                  <option value="">Select staff…</option>
                  {assignableUsers.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.fullName} ({u.employeeCode}) — {DEPARTMENT_LABELS[u.department]}
                    </option>
                  ))}
                </select>
              )}
              {assignError && (
                <p role="alert" className="text-xs text-red-600">
                  {assignError}
                </p>
              )}
              <div className="flex gap-2">
                <button
                  onClick={() => void confirmAssign()}
                  disabled={!selectedAssignee || assignSubmitting}
                  className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                >
                  {assignSubmitting ? 'Assigning…' : 'Confirm'}
                </button>
                <button
                  onClick={() => {
                    setAssigning(false);
                    setSelectedAssignee('');
                    setAssignError(null);
                  }}
                  className="rounded border border-gray-300 px-3 py-1.5 text-sm"
                >
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {allowedTransitions.length > 0 && (
        <div className="flex flex-col gap-2 rounded border border-gray-200 p-3">
          <p className="text-sm font-medium">Change status</p>
          <div className="flex flex-wrap gap-2">
            {allowedTransitions.map((to) => (
              <button
                key={to}
                onClick={() => {
                  setPendingTransition(to);
                  setTransitionError(null);
                }}
                className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white"
              >
                {TRANSITION_BUTTON_LABELS[to] ?? `Mark ${WORK_ORDER_STATUS_LABELS[to]}`}
              </button>
            ))}
          </div>

          {pendingTransition && (
            <div className="flex flex-col gap-2 rounded border border-gray-200 bg-gray-50 p-3">
              <p className="text-sm font-medium">
                {TRANSITION_BUTTON_LABELS[pendingTransition] ?? `Mark ${WORK_ORDER_STATUS_LABELS[pendingTransition]}`}
              </p>

              <label className="flex flex-col gap-1 text-sm">
                {pendingTransition === 'REOPENED' ? 'Note (required — why QC failed)' : 'Note (optional)'}
                <textarea
                  className="rounded border border-gray-300 px-2 py-1"
                  rows={2}
                  value={transitionNote}
                  onChange={(e) => setTransitionNote(e.target.value)}
                />
              </label>

              {pendingTransition === 'DONE' && (
                <div className="flex flex-col gap-2">
                  <p className="text-xs font-medium">
                    Completion photos
                    {needsCompletionPhoto && <span className="ml-1 text-red-600">Required for {WORK_ORDER_TYPE_LABELS[workOrder.type]}</span>}
                  </p>
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/heic"
                    multiple
                    disabled={transitionUploading}
                    onChange={(e) => void handleTransitionFileChange(e)}
                  />
                  {transitionUploading && <p className="text-xs text-gray-500">Uploading…</p>}
                  {transitionPhotos.length > 0 && (
                    <ul className="flex flex-col gap-1">
                      {transitionPhotos.map((photo) => (
                        <li key={photo.fileId} className="flex items-center justify-between text-xs text-gray-700">
                          <span>{photo.filename}</span>
                          <button
                            type="button"
                            onClick={() => setTransitionPhotos((prev) => prev.filter((p) => p.fileId !== photo.fileId))}
                            className="text-red-600 hover:underline"
                          >
                            Remove
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {transitionError && (
                <p role="alert" className="text-sm text-red-600">
                  {transitionError.message}
                </p>
              )}

              <div className="flex gap-2">
                <button
                  onClick={() => void confirmTransition()}
                  disabled={
                    transitionSubmitting ||
                    transitionUploading ||
                    (pendingTransition === 'REOPENED' && transitionNote.trim().length === 0)
                  }
                  className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                >
                  {transitionSubmitting ? 'Saving…' : 'Confirm'}
                </button>
                <button onClick={resetTransitionForm} className="rounded border border-gray-300 px-3 py-1.5 text-sm">
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

type DashboardMode = 'MY_TASKS' | 'DEPARTMENT_QUEUE' | 'FULL_LIST';

// Spec §8.3: "build one dashboard component with configurable widget
// sets, not thirteen bespoke pages." Mode is derived from the exact same
// permission/scope data the backend already uses to filter query results
// (workorders/service.ts's visibilityWhereClause) — never a hardcoded
// role check — so which dashboard shape a role gets can only change by
// changing what it's granted, not by editing this file.
// - FULL_LIST: an ALL-scoped workorder:read_all holder (SYSTEM_ADMIN,
//   RESORT_MANAGER, OPS_SAFETY_SUPERVISOR, ADMIN_HEAD, OWNER) already
//   sees every ticket from a plain GET /work-orders — the existing flat
//   list is the right shape for a property-wide role.
// - DEPARTMENT_QUEUE: a DEPARTMENT-scoped read_all holder, or anyone
//   holding workorder:assign without ALL-scope read (POC_HOUSEKEEPING,
//   POC_MAINTENANCE, RESTAURANT_MANAGER) — spec §8.3's "room status
//   board... assignment panel" / "incoming repair queue... assignment
//   panel" shape. The backend already scopes their plain GET to their
//   own department; this mode just groups that same response by status.
// - MY_TASKS: the floor — everyone else (Room Attendant, Maintenance
//   Tech, Resort Staff, Restaurant Staff, Admin Staff, Cashier). Spec
//   §8.3's "My rooms today" / "My tickets today" — tickets assigned to
//   them specifically, fetched with ?mine=true.
function deriveDashboardMode(user: CurrentUser | null): DashboardMode {
  if (!user) return 'MY_TASKS';
  const readAllScope = user.permissions['workorder:read_all'];
  if (readAllScope === 'ALL') return 'FULL_LIST';
  if (readAllScope === 'DEPARTMENT' || user.permissions['workorder:assign']) return 'DEPARTMENT_QUEUE';
  return 'MY_TASKS';
}

const DEPARTMENT_QUEUE_GROUPS: { key: string; label: string; statuses: WorkOrderStatusKey[] }[] = [
  { key: 'unassigned', label: 'Unassigned', statuses: ['OPEN'] },
  { key: 'in_progress', label: 'Assigned / in progress', statuses: ['ASSIGNED', 'IN_PROGRESS', 'REOPENED'] },
  { key: 'awaiting_verification', label: 'Awaiting verification', statuses: ['DONE'] },
  { key: 'closed', label: 'Verified / cancelled', statuses: ['VERIFIED', 'CANCELLED'] },
];

function WorkOrderListRow({ wo, onSelect }: { wo: WorkOrderRow; onSelect: (id: string) => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(wo.id)}
        className="flex w-full flex-wrap items-center gap-2 rounded border border-gray-200 p-3 text-left hover:border-blue-400"
      >
        <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${WORK_ORDER_STATUS_CLASSES[wo.status]}`}>
          {WORK_ORDER_STATUS_LABELS[wo.status]}
        </span>
        <span className="text-xs font-mono text-gray-500">{wo.referenceNo}</span>
        <span className="text-sm font-medium">{wo.title}</span>
        <span className="text-xs text-gray-500">
          {WORK_ORDER_TYPE_LABELS[wo.type]} · {DEPARTMENT_LABELS[wo.department]} · {WORK_ORDER_PRIORITY_LABELS[wo.priority]}
        </span>
        {wo.unit && <span className="text-xs text-gray-500">Unit {wo.unit.code}</span>}
        {wo.assignedTo && <span className="text-xs text-gray-500">Assigned: {wo.assignedTo.fullName}</span>}
      </button>
    </li>
  );
}

function WorkOrderList({ workOrders, onSelect, emptyMessage }: { workOrders: WorkOrderRow[]; onSelect: (id: string) => void; emptyMessage: string }) {
  if (workOrders.length === 0) {
    return <p className="text-sm text-gray-500">{emptyMessage}</p>;
  }
  return (
    <ul className="flex flex-col gap-2">
      {workOrders.map((wo) => (
        <WorkOrderListRow key={wo.id} wo={wo} onSelect={onSelect} />
      ))}
    </ul>
  );
}

// Spec §8.3: "Room Attendant — a single list... Nothing else." A worker
// on this dashboard cares about what's assigned to them right now, so
// open/in-progress/reopened tickets sort first (oldest due first),
// leaving DONE/VERIFIED/CANCELLED tickets at the bottom rather than
// mixed in chronologically.
const MY_TASKS_ACTIVE_STATUSES: WorkOrderStatusKey[] = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'REOPENED'];

function sortForMyTasks(workOrders: WorkOrderRow[]): WorkOrderRow[] {
  return [...workOrders].sort((a, b) => {
    const aActive = MY_TASKS_ACTIVE_STATUSES.includes(a.status);
    const bActive = MY_TASKS_ACTIVE_STATUSES.includes(b.status);
    if (aActive !== bActive) return aActive ? -1 : 1;
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });
}

export function WorkOrdersPage() {
  const { user } = useAuth();
  const mode = deriveDashboardMode(user);
  const [workOrders, setWorkOrders] = useState<WorkOrderRow[] | 'loading' | 'error'>('loading');
  // FULL_LIST-only: a property-wide role (SYSTEM_ADMIN, RESORT_MANAGER,
  // ...) can genuinely be assigned a ticket too, but had no quick way to
  // see just their own without scanning the entire property's list —
  // real gap found live-testing. Additive to the full list below, not a
  // replacement — MY_TASKS and DEPARTMENT_QUEUE are unaffected.
  const [myWorkOrders, setMyWorkOrders] = useState<WorkOrderRow[] | 'loading' | 'error'>('loading');
  const [units, setUnits] = useState<UnitOption[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    setWorkOrders('loading');
    // MY_TASKS fetches with ?mine=true — assigned-to-me only, spec §8.3's
    // "My rooms today" / "My tickets today". The other two modes fetch
    // the plain list: the backend's own visibility rule (service.ts's
    // visibilityWhereClause) already scopes it to "my department" for a
    // DEPARTMENT_QUEUE caller and "everything" for a FULL_LIST caller —
    // this page just groups/labels that same response differently.
    api
      .get<{ workOrders: WorkOrderRow[] }>(mode === 'MY_TASKS' ? '/work-orders?mine=true' : '/work-orders')
      .then((res) => setWorkOrders(res.workOrders))
      .catch(() => setWorkOrders('error'));
    // FULL_LIST also fetches its own ?mine=true — the same query MY_TASKS
    // uses — purely to power the additive "Assigned to you" section; a
    // property-wide role's ALL-scope visibility already lets this same
    // filter narrow correctly, same backend rule, no new endpoint needed.
    if (mode === 'FULL_LIST') {
      setMyWorkOrders('loading');
      api
        .get<{ workOrders: WorkOrderRow[] }>('/work-orders?mine=true')
        .then((res) => setMyWorkOrders(res.workOrders))
        .catch(() => setMyWorkOrders('error'));
    }
    // Best-effort: not every role that can create a ticket also holds
    // unit:read (e.g. Restaurant Staff filing a GENERAL ticket) — if
    // this fails, the "Related unit" field just doesn't render rather
    // than blocking the whole page.
    api
      .get<{ units: UnitOption[] }>('/units')
      .then((res) => setUnits(res.units))
      .catch(() => setUnits([]));
  }, [mode]);

  function handleCreated(workOrder: WorkOrderRow) {
    setWorkOrders((prev) => (Array.isArray(prev) ? [workOrder, ...prev] : [workOrder]));
  }

  function handleDetailChanged(workOrder: WorkOrderRow) {
    setWorkOrders((prev) =>
      Array.isArray(prev) ? prev.map((wo) => (wo.id === workOrder.id ? { ...wo, ...workOrder } : wo)) : prev,
    );
    setMyWorkOrders((prev) =>
      Array.isArray(prev) ? prev.map((wo) => (wo.id === workOrder.id ? { ...wo, ...workOrder } : wo)) : prev,
    );
  }

  const heading = mode === 'MY_TASKS' ? 'My Tasks' : mode === 'DEPARTMENT_QUEUE' ? 'Department Work Orders' : 'Work Orders';

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-lg font-semibold">{heading}</h1>

      {mode === 'MY_TASKS' && (
        <details className="rounded border border-gray-200 p-3">
          <summary className="cursor-pointer text-sm font-semibold text-gray-700">Report an issue / new ticket</summary>
          <div className="mt-3">
            {user?.permissions['workorder:create'] && <NewWorkOrderForm units={units} onCreated={handleCreated} />}
          </div>
        </details>
      )}
      {mode !== 'MY_TASKS' && user?.permissions['workorder:create'] && (
        <NewWorkOrderForm units={units} onCreated={handleCreated} />
      )}

      {workOrders === 'loading' && <p className="text-sm text-gray-500">Loading…</p>}
      {workOrders === 'error' && <p role="alert">Could not load work orders.</p>}

      {Array.isArray(workOrders) && mode === 'MY_TASKS' && (
        <section>
          <h2 className="mb-2 text-sm font-semibold text-gray-700">Assigned to you</h2>
          <WorkOrderList
            workOrders={sortForMyTasks(workOrders)}
            onSelect={setSelectedId}
            emptyMessage="Nothing assigned to you right now."
          />
        </section>
      )}

      {Array.isArray(workOrders) && mode === 'DEPARTMENT_QUEUE' && (
        <>
          {DEPARTMENT_QUEUE_GROUPS.map((group) => {
            const grouped = workOrders.filter((wo) => group.statuses.includes(wo.status));
            if (group.key === 'closed' && grouped.length === 0) return null;
            return (
              <section key={group.key}>
                <h2 className="mb-2 text-sm font-semibold text-gray-700">
                  {group.label} <span className="font-normal text-gray-400">({grouped.length})</span>
                </h2>
                <WorkOrderList workOrders={grouped} onSelect={setSelectedId} emptyMessage="Nothing here right now." />
              </section>
            );
          })}
        </>
      )}

      {mode === 'FULL_LIST' && (
        <section>
          <h2 className="mb-2 text-sm font-semibold text-gray-700">Assigned to you</h2>
          {myWorkOrders === 'loading' && <p className="text-sm text-gray-500">Loading…</p>}
          {myWorkOrders === 'error' && <p role="alert">Could not load your assigned tickets.</p>}
          {Array.isArray(myWorkOrders) && (
            <WorkOrderList
              workOrders={sortForMyTasks(myWorkOrders)}
              onSelect={setSelectedId}
              emptyMessage="Nothing assigned to you right now."
            />
          )}
        </section>
      )}

      {Array.isArray(workOrders) && mode === 'FULL_LIST' && (
        <section>
          <h2 className="mb-2 text-sm font-semibold text-gray-700">Tickets</h2>
          <WorkOrderList workOrders={workOrders} onSelect={setSelectedId} emptyMessage="No tickets yet." />
        </section>
      )}

      {selectedId && (
        <WorkOrderDetailDrawer id={selectedId} onClose={() => setSelectedId(null)} onChanged={handleDetailChanged} />
      )}
    </div>
  );
}
