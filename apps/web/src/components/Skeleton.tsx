// Spec §11 M6: "loading skeletons." Confirmed 2026-08-26: every page's
// loading state was ad hoc — the same `<p>Loading…</p>` line
// hand-typed independently in 8 files, 17 places. Three composed shapes
// below, not a generic "any shape" placeholder — they match the three
// visual shapes actually on screen across this app today: a `<table>`
// (most list pages), a `<ul>` (Dashboard's attention queue / activity
// feed, notifications), and a KPI/stat tile (Dashboard, report
// summaries).

// The one atomic primitive everything else composes from.
export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-gray-200 ${className}`} />;
}

export function SkeletonTableRows({ rows = 3, columns = 4 }: { rows?: number; columns?: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, rowIndex) => (
        <tr key={rowIndex}>
          {Array.from({ length: columns }, (_, colIndex) => (
            <td key={colIndex} className="py-2 pr-4">
              <Skeleton className="h-4 w-full max-w-[10rem]" />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

export function SkeletonList({ items = 3 }: { items?: number }) {
  return (
    <ul className="flex flex-col gap-2">
      {Array.from({ length: items }, (_, index) => (
        <li key={index} className="flex items-center justify-between rounded border border-gray-100 px-3 py-2">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-10" />
        </li>
      ))}
    </ul>
  );
}

export function SkeletonCard() {
  return (
    <div className="rounded border border-gray-200 p-3">
      <Skeleton className="mb-2 h-7 w-12" />
      <Skeleton className="h-3 w-20" />
    </div>
  );
}
