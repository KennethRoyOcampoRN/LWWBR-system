// Visual redesign, step 1 (client-directed, 2026-11-xx): a real type
// scale, replacing the de facto "two sizes" every page had collapsed
// onto — every section heading hand-typed as `text-base font-semibold`,
// every description as `text-sm text-gray-500`, with no distinction
// between a page title, a section title, body copy, and a caption/meta
// note. Four tiers, applied through the primitives below rather than
// hand-typed per page:
//   PAGE_TITLE    — the one <h1> per page (was text-lg/text-xl, inconsistent)
//   SECTION_TITLE — a <h2>/<h3> inside a Card/Section (kept at the
//                   existing text-base size — that part was already
//                   consistent — but recolored to `text-ink`, not the
//                   mixed ink-secondary/gray-500 pages used ad hoc)
//   BODY          — real descriptive copy (a paragraph under a heading)
//   CAPTION       — meta/helper text: timestamps, hints, table footnotes
export const PAGE_TITLE = 'text-xl font-semibold leading-tight text-ink';
export const SECTION_TITLE = 'text-base font-semibold text-ink';
export const BODY = 'text-sm leading-relaxed text-ink-secondary';
export const CAPTION = 'text-xs text-ink-muted';

// Spacing rhythm, same slice: a fixed small set of gap values rather than
// an ad-hoc one per page (existing pages used gap-1, gap-2, gap-3, gap-4,
// gap-6, gap-10 somewhat interchangeably for similar jobs). The
// primitives below only use these three:
//   STACK_GAP      — vertical rhythm between unrelated blocks on a page
//                    (PageHeader to first Section, Section to Section)
//   CARD_GAP       — vertical rhythm *inside* a Card/Section (heading to
//                    body, body to table, table to form)
//   INLINE_GAP     — horizontal rhythm between inline controls (a row of
//                    buttons, a FilterBar's fields, a badge next to text)
export const STACK_GAP = 'gap-6';
export const CARD_GAP = 'gap-4';
export const INLINE_GAP = 'gap-3';
