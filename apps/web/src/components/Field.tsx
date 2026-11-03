import type { ReactNode } from 'react';
import { CAPTION } from './typography.js';

// Visual redesign, step 1 (client-directed, 2026-11-xx): every form
// field across the hand-rolled pages is its own
// `<label className="flex flex-col gap-1 text-sm">Label<input ... /></label>`,
// with the error message (when there is one) rendered separately,
// inconsistently placed, by the surrounding form. `Field` is just that
// shape, shared — label, the input itself (passed as `children` so this
// stays input-type-agnostic: a plain `<input>`, a `<select>`, a
// `<textarea>`, the hidden-file-input-plus-button pattern ShiftsPage
// uses — Field never has to know which), and an error/hint slot that's
// always in the same place.
//
// Error text uses `text-danger-600` directly on white (not the -50
// tint) — measured at 5.67:1, passing WCAG 1.4.3's 4.5:1 floor for
// normal/small text with margin (same token, same method as
// StatusBadge's own comment).
//
// `INPUT_CLASSES` is exported alongside, not baked into Field itself,
// since Field doesn't render the input — a converted page applies it to
// whatever input element it passes as `children`, keeping one shared
// look without forcing every input through a single rigid component.
export const INPUT_CLASSES = 'rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100';

export function Field({
  label,
  error,
  hint,
  children,
}: {
  label: ReactNode;
  error?: string | null;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 text-sm">
      {/* Real bug, caught converting StockPage: hint/error used to be
          siblings inside this same <label>, which means an implicit
          label's accessible-name computation concatenates ALL text
          content inside it — `getByLabelText('Unit of measure')` broke
          the moment a hint like "e.g. pack, bottle, pcs" was added,
          since the real accessible name became "Unit of measure e.g.
          pack, bottle, pcs". The label now wraps only the label text
          and the input itself; hint/error render as a sibling outside
          it, so they're visible and associated visually without
          polluting the one thing other code (and screen readers) read
          as this field's name. */}
      <label className="flex flex-col gap-1">
        <span className="font-medium text-ink">{label}</span>
        {children}
      </label>
      {error ? (
        <span role="alert" className="text-xs font-medium text-danger-600">
          {error}
        </span>
      ) : (
        hint && <span className={CAPTION}>{hint}</span>
      )}
    </div>
  );
}
