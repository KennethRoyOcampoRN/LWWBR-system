import type { ReactNode } from 'react';
import { BODY, CARD_GAP, INLINE_GAP, SECTION_TITLE } from './typography.js';

// Visual redesign, step 1 (client-directed, 2026-11-xx): extracted from
// Command Center's own surface treatment (DashboardPage.tsx's
// `rounded-2xl bg-white p-4 shadow-card`), which until now only existed
// as that one hand-typed class string, repeated differently (or not at
// all — most hand-rolled pages have no card surface, just a bare
// `<div className="flex flex-col gap-6">`) on every other page.
//
// `Card` is the bare surface — anything that needs the "floating white
// panel" treatment without necessarily being a titled section (e.g. a
// form, a single stat). `padding="none"` is for a caller that wants the
// shadow/radius/background but owns its own internal padding (a table
// that should bleed to the card's edges before `overflow-x-auto` kicks
// in on narrow screens, for instance).
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
  return <div className={`rounded-2xl bg-white shadow-card ${paddingClass} ${className}`.trim()}>{children}</div>;
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
