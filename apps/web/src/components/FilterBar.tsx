import type { ReactNode } from 'react';
import { INLINE_GAP } from './typography.js';

// Visual redesign, step 1 (client-directed, 2026-11-xx): the From/To/
// Employee row pattern repeats (ShiftsPage's AllTimeLogsSection today;
// a date-range picker on ReportsPage) as a hand-typed
// `<div className="flex flex-wrap gap-3">`. `FilterBar` is just that
// wrapper, named, so every filter row wraps and spaces its fields the
// same way — each field inside is still a plain `Field` (or a bare
// label+input), FilterBar only owns the row layout.
export function FilterBar({ children }: { children: ReactNode }) {
  return <div className={`flex flex-wrap items-end ${INLINE_GAP}`}>{children}</div>;
}
