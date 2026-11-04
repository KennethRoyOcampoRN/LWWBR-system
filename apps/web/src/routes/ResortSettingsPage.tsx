import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '../components/Button.js';
import { Section } from '../components/Card.js';
import { Field, INPUT_CLASSES } from '../components/Field.js';
import { PageHeader } from '../components/PageHeader.js';
import { api, ApiRequestError } from '../lib/api.js';

interface LogoFile {
  id: string;
  filename: string;
  mimeType: string;
  url: string;
}

interface ResortIdentity {
  name: string;
  address: string;
  cellNo: string | null;
  contactNo: string | null;
  website: string | null;
  facebookUrl: string | null;
  logo: LogoFile | null;
}

const EMPTY_FORM = {
  name: '',
  address: '',
  cellNo: '',
  contactNo: '',
  website: '',
  facebookUrl: '',
};

// Build plan stage 2 (spec.md §13 decision 13, 2026-11-04): the resort-
// identity fields a Receipt's header snapshot is sourced from (name,
// address, Cell No./Contact No. as two separate fields per the sample
// receipt, website, Facebook, logo). System Admin / Resort Manager only
// (resort:configure) — see permissions.ts's own comment for why this
// isn't folded into system:configure, which already gates unrelated
// LAN/geofence settings.
//
// Logo upload reuses the existing generic POST /files + GET /files/signed
// round trip (same one ShiftsPage's selfie capture and every other
// photo-evidence feature in this app already uses) rather than a new
// upload mechanism — this page only adds the "set logoFileId on the
// resort-identity Setting" step on top of that.
export function ResortSettingsPage() {
  const [identity, setIdentity] = useState<ResortIdentity | 'loading' | 'error'>('loading');
  const [form, setForm] = useState(EMPTY_FORM);
  const [logo, setLogo] = useState<LogoFile | null>(null);
  const [logoUploading, setLogoUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function fetchIdentity() {
    setIdentity('loading');
    return api
      .get<{ resortIdentity: ResortIdentity }>('/settings/resort-identity')
      .then((res) => {
        setIdentity(res.resortIdentity);
        setForm({
          name: res.resortIdentity.name,
          address: res.resortIdentity.address,
          cellNo: res.resortIdentity.cellNo ?? '',
          contactNo: res.resortIdentity.contactNo ?? '',
          website: res.resortIdentity.website ?? '',
          facebookUrl: res.resortIdentity.facebookUrl ?? '',
        });
        setLogo(res.resortIdentity.logo);
      })
      .catch(() => setIdentity('error'));
  }

  useEffect(() => {
    void fetchIdentity();
  }, []);

  async function handleLogoChange(file: File | null) {
    if (!file) return;
    setLogoUploading(true);
    setError(null);
    try {
      const uploaded = await api.upload<{ file: { id: string; filename: string; mimeType: string } }>(
        '/files',
        file,
      );
      // No signed URL to preview with yet — the upload response is just
      // the raw FileObject, not a signed one (see files/service.ts's
      // own UploadedFile shape). A local object URL previews the exact
      // bytes just chosen, good enough until the next save/reload swaps
      // it for the real signed URL from the server.
      setLogo({ id: uploaded.file.id, filename: uploaded.file.filename, mimeType: uploaded.file.mimeType, url: URL.createObjectURL(file) });
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not upload the logo.');
    } finally {
      setLogoUploading(false);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setSubmitting(true);
    try {
      const res = await api.patch<{ resortIdentity: ResortIdentity }>('/settings/resort-identity', {
        name: form.name.trim(),
        address: form.address.trim(),
        cellNo: form.cellNo.trim() || null,
        contactNo: form.contactNo.trim() || null,
        website: form.website.trim() || null,
        facebookUrl: form.facebookUrl.trim() || null,
        logoFileId: logo?.id ?? null,
      });
      setIdentity(res.resortIdentity);
      setLogo(res.resortIdentity.logo);
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not save the resort identity.');
    } finally {
      setSubmitting(false);
    }
  }

  if (identity === 'loading') {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Resort Settings" />
        <p className="text-sm text-ink-secondary">Loading…</p>
      </div>
    );
  }
  if (identity === 'error') {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Resort Settings" />
        <p role="alert">Could not load the resort identity.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Resort Settings" description="Printed on every acknowledgement receipt." />

      <Section title="Resort identity">
        <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-4">
          {error && (
            <p role="alert" className="text-sm font-medium text-danger-600">
              {error}
            </p>
          )}
          {saved && !error && <p className="text-sm font-medium text-success-600">Saved.</p>}

          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-ink">Logo</span>
            {logo && (
              <img src={logo.url} alt="Resort logo" className="h-20 w-20 rounded-lg border border-gray-200 object-contain" />
            )}
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,image/heic"
              disabled={logoUploading}
              aria-label="Resort logo"
              onChange={(e) => void handleLogoChange(e.target.files?.[0] ?? null)}
            />
            {logo && (
              <Button type="button" variant="secondary" onClick={() => setLogo(null)} disabled={logoUploading}>
                Remove logo
              </Button>
            )}
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Resort name">
              <input
                required
                className={INPUT_CLASSES}
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </Field>
            <Field label="Address">
              <input
                required
                className={INPUT_CLASSES}
                value={form.address}
                onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
              />
            </Field>
            <Field label="Cell No.">
              <input
                className={INPUT_CLASSES}
                value={form.cellNo}
                onChange={(e) => setForm((f) => ({ ...f, cellNo: e.target.value }))}
              />
            </Field>
            <Field label="Contact No.">
              <input
                className={INPUT_CLASSES}
                value={form.contactNo}
                onChange={(e) => setForm((f) => ({ ...f, contactNo: e.target.value }))}
              />
            </Field>
            <Field label="Website">
              <input
                className={INPUT_CLASSES}
                value={form.website}
                onChange={(e) => setForm((f) => ({ ...f, website: e.target.value }))}
              />
            </Field>
            <Field label="Facebook">
              <input
                className={INPUT_CLASSES}
                value={form.facebookUrl}
                onChange={(e) => setForm((f) => ({ ...f, facebookUrl: e.target.value }))}
              />
            </Field>
          </div>

          <Button type="submit" disabled={submitting || logoUploading}>
            {submitting ? 'Saving…' : 'Save'}
          </Button>
        </form>
      </Section>
    </div>
  );
}
