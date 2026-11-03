import type { ReactNode } from 'react';
import { BODY, INLINE_GAP, PAGE_TITLE } from './typography.js';

// Visual redesign, step 1 (client-directed, 2026-11-xx): extracted from
// Command Center's own page-title block (DashboardPage.tsx's
// `<h1 className="text-xl font-semibold leading-tight text-ink">` +
// description paragraph), generalized for every other page's own
// "<h1> + one-line description" header, which until now was hand-typed
// per page at inconsistent sizes (`text-lg`, `text-xl`) and colors.
//
// Density follow-up, same slice: `description` is meant to be one short
// line, not the multi-sentence paragraph most pages currently carry
// under their heading — see each converted page's own call site for
// where that copy was trimmed. This component doesn't enforce length;
// it only stops the page title itself from being the inconsistent part.
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className={`flex flex-wrap items-start justify-between ${INLINE_GAP}`}>
      <div className="flex flex-col gap-1">
        <h1 className={PAGE_TITLE}>{title}</h1>
        {description && <p className={BODY}>{description}</p>}
      </div>
      {actions && <div className={`flex shrink-0 flex-wrap items-center ${INLINE_GAP}`}>{actions}</div>}
    </div>
  );
}
