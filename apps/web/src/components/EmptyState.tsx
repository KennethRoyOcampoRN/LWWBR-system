import type { ReactNode } from 'react';
import { BODY } from './typography.js';

// Spec §11 M6: "empty states." Confirmed 2026-08-26: the same
// `text-sm text-gray-500` treatment was already the de facto standard
// across the app, just hand-typed independently at every call site (6
// files) instead of shared — this centralizes it rather than changing
// how it looks. `action` is optional since most existing empty states
// are plain text with no follow-up control; a call site that wants one
// (e.g. "No amenity items yet" next to an Add button) can still pass it.
//
// Visual redesign, step 1 (client-directed, 2026-11-xx): folded into the
// new primitive set — now uses the shared `BODY` tier (typography.ts)
// instead of its own hand-typed `text-sm text-gray-500`, so it matches
// whatever color/line-height every other body-copy use of that tier
// gets, rather than drifting from it independently.
export function EmptyState({ message, action }: { message: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-2">
      <p className={BODY}>{message}</p>
      {action}
    </div>
  );
}
