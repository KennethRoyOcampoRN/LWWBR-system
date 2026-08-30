import type { ReactNode } from 'react';

// Spec §11 M6: "empty states." Confirmed 2026-08-26: the same
// `text-sm text-gray-500` treatment was already the de facto standard
// across the app, just hand-typed independently at every call site (6
// files) instead of shared — this centralizes it rather than changing
// how it looks. `action` is optional since most existing empty states
// are plain text with no follow-up control; a call site that wants one
// (e.g. "No amenity items yet" next to an Add button) can still pass it.
export function EmptyState({ message, action }: { message: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-2">
      <p className="text-sm text-gray-500">{message}</p>
      {action}
    </div>
  );
}
