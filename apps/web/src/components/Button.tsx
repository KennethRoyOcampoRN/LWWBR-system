import type { ButtonHTMLAttributes } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'danger';

// Visual redesign, step 1 (client-directed, 2026-11-xx): every button
// across the nine hand-rolled pages is a one-off `<button className="...">`
// — `rounded bg-blue-700 px-4 py-2 text-sm font-medium text-white` for a
// submit, `text-sm text-red-700 hover:underline` for a destructive
// inline action, neither using the brand/danger tokens this app already
// has. Three variants, matched to how those one-offs are actually used:
// primary (the one submit action per form), secondary (Cancel, a
// lower-emphasis action next to a primary one), danger (Delete).
//
// Measured contrast (same method as StatusBadge's own comment — WCAG
// 2.1 relative-luminance ratio from the token hex values):
//   primary   white text on brand-600    4.86:1 (passes 4.5:1)
//   secondary brand-700 text on white    6.25:1
//   danger    white text on danger-600   5.67:1
// `hover:bg-{color}-600/90` rather than a `-700` shade for primary/
// danger's hover state: danger has no `-700` token defined (only 50/600
// — see tailwind.config.js), so this uses one consistent opacity-based
// hover across all three solid variants instead of a shade that exists
// for brand but not danger.
const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: 'bg-brand-600 text-white hover:bg-brand-600/90 focus-visible:outline-brand-600',
  secondary:
    'border border-brand-200 bg-white text-brand-700 hover:bg-brand-50 focus-visible:outline-brand-600',
  danger: 'bg-danger-600 text-white hover:bg-danger-600/90 focus-visible:outline-danger-600',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

export function Button({ variant = 'primary', className = '', type = 'button', ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={`inline-flex w-fit items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${VARIANT_CLASSES[variant]} ${className}`.trim()}
      {...rest}
    />
  );
}
