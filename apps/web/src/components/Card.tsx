import type { ReactNode } from 'react';
import { BODY, CARD_GAP, INLINE_GAP, SECTION_TITLE } from './typography.js';

// Visual redesign, round 1 (client-directed, 2026-11-xx): extracted from
// Command Center's own surface treatment (DashboardPage.tsx's
// `rounded-2xl bg-white p-4 shadow-card`), which until now only existed
// as that one hand-typed class string, repeated differently (or not at
// all — most hand-rolled pages have no card surface, just a bare
// `<div className="flex flex-col gap-6">`) on every other page.
//
// Round 2 (spec.md §13 decision 40, 2026-11-20), client-reported: "every
// piece of content in an identical white rounded card, the same border
// radius on everything regardless of importance, the same soft grey
// shadow under each" was named directly as why the app reads as a
// generic admin template. The shadow is gone — a flat hairline border
// instead, the same weight every other structural line in this system
// now uses — and the radius comes down one step (`rounded-2xl` to
// `rounded-xl`) so page-level surfaces read as deliberately less rounded
// than the room board's own tiles (UnitsPage.tsx), which keep the
// larger radius precisely so the signature element reads as more
// considered than an ordinary content card, not the same shape as one.
// `shadow-card` the token still exists (tailwind.config.js's own
// comment) for a genuinely floating element — a dropdown, a toast, a
// modal — none of which exist in this app yet; it is not applied here
// by default any more.
//
// `Card` is the bare surface — anything that needs the panel treatment
// without necessarily being a titled section (e.g. a form, a single
// stat). `padding="none"` is for a caller that wants the border/radius/
// background but owns its own internal padding (a table that should
// bleed to the card's edges before `overflow-x-auto` kicks in on narrow
// screens, for instance).
export function Card({
  children,
  className = '',
  padding = 'default',
}: {
  children: ReactNode;
  className?: string;
  padding?: 'none' | 'default';
}) {
  const paddingClass = padding === 'none' ? '' : 'p-4 sm:p-6';
  return <div className={`rounded-xl border border-gray-200 bg-white ${paddingClass} ${className}`.trim()}>{children}</div>;
}

// `Section` is a Card with a titled header built in — the shape every
// one of the nine hand-rolled table pages actually needs: a heading, an
// optional one-line description, an optional actions slot (e.g. a
// FilterBar, or a single "Add" button), then content. Not every Section
// needs the Card surface underneath it (Command Center's own "Property
// status" KPI strip is a titled block with no card background at all),
// so the surface is opt-in via `surface`, not baked in unconditionally.
export function Section({
  title,
  description,
  actions,
  children,
  className = '',
  surface = true,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  surface?: boolean;
}) {
  const body = (
    <div className={`flex flex-col ${CARD_GAP} ${className}`.trim()}>
      {(title || actions) && (
        <div className={`flex flex-wrap items-start justify-between ${INLINE_GAP}`}>
          <div className="flex flex-col gap-1">
            {title && <h2 className={SECTION_TITLE}>{title}</h2>}
            {description && <p className={BODY}>{description}</p>}
          </div>
          {actions && <div className={`flex shrink-0 flex-wrap items-center ${INLINE_GAP}`}>{actions}</div>}
        </div>
      )}
      {children}
    </div>
  );
  if (!surface) return <section>{body}</section>;
  return (
    <section>
      <Card>{body}</Card>
    </section>
  );
}
