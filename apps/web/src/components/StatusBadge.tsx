import type { ReactNode } from 'react';

export type StatusBadgeVariant = 'success' | 'warning' | 'danger' | 'info' | 'accent' | 'neutral';

// Visual redesign, step 1 (client-directed, 2026-11-xx): every status
// across the nine hand-rolled table pages renders as plain text today
// ("Normal", "Active", "Done" with no visual weight at all) or as an
// ad-hoc one-off badge (amber-100/amber-900 border-amber-300 on
// ShiftsPage, green-100/green-900 elsewhere) — never the semantic
// success/warning/danger/info/accent tokens tailwind.config.js already
// defines. This is the one shared badge.
//
// Measured, not eyeballed (WCAG 2.1 relative-luminance contrast ratio,
// computed from the token hex values, not read off a screenshot):
// tailwind.config.js's own comment already measured the -50/-600 tint
// pairing (icon-on-its-own-tint) at a 3.72:1 floor — enough for a
// graphical object (WCAG 1.4.11's 3:1), nowhere near enough for *text*
// (WCAG 1.4.3's 4.5:1 floor for normal and small text — this badge's
// text-xs label never qualifies as "large text" regardless of weight,
// which needs >=18.66px bold). Re-measuring that same -50/-600 pairing
// specifically as text:
//   success-50/600  5.34:1  (passes 4.5:1)
//   info-50/600     6.20:1  (passes 4.5:1)
//   warning-50/600  4.31:1  (FAILS 4.5:1)
//   danger-50/600   4.23:1  (FAILS 4.5:1)
//   accent-50/600   4.27:1  (FAILS 4.5:1)
// Three of five fail outright, so this badge does not use the tint
// pairing for its text. It fills solid with -600 and sets white text
// instead — same five tokens, inverted, and every one clears 4.5:1 with
// real margin:
//   success-600/white  6.39:1
//   warning-600/white  5.02:1
//   danger-600/white   5.67:1
//   info-600/white     7.90:1
//   accent-600/white   5.39:1
// `neutral` (no semantic meaning — e.g. "Normal") uses `ink` on
// `gray-100`, measured at 14.90:1.
const VARIANT_CLASSES: Record<StatusBadgeVariant, string> = {
  success: 'bg-success-600 text-white',
  warning: 'bg-warning-600 text-white',
  danger: 'bg-danger-600 text-white',
  info: 'bg-info-600 text-white',
  accent: 'bg-accent-600 text-white',
  neutral: 'bg-gray-100 text-ink',
};

export function StatusBadge({ variant, children }: { variant: StatusBadgeVariant; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${VARIANT_CLASSES[variant]}`}
    >
      {children}
    </span>
  );
}
