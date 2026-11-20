// Visual redesign, round 1 (2026-11-xx): a real type scale, replacing
// the de facto "two sizes" every page had collapsed onto. Round 2
// (spec.md §13 decision 40, 2026-11-20), client-reported: those four
// tiers existed but were only wired into 2-3 pages (Command Center,
// Units, Billing) — every other page still hand-typed `text-base
// font-semibold` for literally everything, which is exactly the "a
// page title and a section title are both text-base font-semibold"
// complaint, confirmed true for those pages by grep before this round
// started. Two tiers added here (NUMERIC_HERO/NUMERIC_KPI) because the
// same drift had already happened to numbers specifically — Billing's
// Amount Due was a hand-typed `text-4xl font-bold`, Command Center's
// KPI tiles were a hand-typed `text-2xl font-semibold`, neither a
// shared primitive, nothing stopping a ninth page inventing a third
// size. Six tiers now, every one meant to be reached for by name, not
// retyped:
//   PAGE_TITLE     — the one <h1> per page
//   SECTION_TITLE  — a <h2>/<h3> inside a Card/Section
//   BODY           — real descriptive copy (a paragraph under a heading)
//   CAPTION        — meta/helper text: timestamps, hints, table footnotes
//   NUMERIC_HERO   — the one big figure per page (an Amount Due, a hero stat)
//   NUMERIC_KPI    — a tile's own smaller figure (a Command Center KPI card)
//
// PAGE_TITLE bumped from text-xl to text-2xl this round specifically so
// it reads as unmistakably a size class above SECTION_TITLE rather than
// one step — 24px vs 16px, not 20px vs 16px.
export const PAGE_TITLE = 'text-2xl font-semibold leading-tight text-ink';
export const SECTION_TITLE = 'text-base font-semibold text-ink';
export const BODY = 'text-sm leading-relaxed text-ink-secondary';
export const CAPTION = 'text-xs text-ink-muted';
// `font-mono` + `tabular-nums`: IBM Plex Mono's own lining figures, used
// for every money amount and quantity figure in the app, not just these
// two hero/KPI tiers — a receipt line or a room rate should align the
// same way a spreadsheet column does. See index.css's own comment for
// why Mono is reserved for numerals specifically rather than used
// anywhere else.
export const NUMERIC_HERO = 'font-mono text-4xl font-bold tabular-nums text-ink';
export const NUMERIC_KPI = 'font-mono text-2xl font-semibold tabular-nums text-ink';

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
