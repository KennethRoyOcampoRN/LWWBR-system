import type { ReactNode } from 'react';
import { EmptyState } from './EmptyState.js';
import { SkeletonTableRows } from './Skeleton.js';

// Visual redesign, step 1 (client-directed, 2026-11-xx): the keystone.
// Nine pages (Amenities, F&B, Quotations, Remittance, Reports, Sessions,
// Shifts, Stock, Users) each hand-roll their own `<table>`, and
// responsive breakpoint usage across the app is near-zero (WorkOrders 1,
// Users 1, Roles 2, Stock 3, FnbPage 3, Units 4) — meaning every one of
// those tables is unusable on a phone: a wide multi-column table either
// overflows (if wrapped in `overflow-x-auto`, which most are) forcing
// horizontal scroll to read a single row, or breaks layout outright.
// One component, used by all nine, fixes both problems at once: a real
// `<table>` on a wide-enough screen, the same rows re-rendered as
// stacked cards below `md` (640px-ish phones; `md` matches the
// breakpoint AppShell's own nav already switches the sidebar on).
//
// Its API was designed against the actual column shapes those nine
// pages need — surveyed before writing this, not invented then
// retrofitted onto one page and hoped to generalize:
//   - every page has a Status column (StockPage: Active/Inactive,
//     AmenitiesPage: condition, ShiftsPage: Normal/Flagged/Reviewed) —
//     `render` returning a <StatusBadge> handles this, no special case
//   - most pages have a conditional Actions column, present only for
//     some permission (`canManage && <th>...`) — the caller simply
//     omits the column object from the `columns` array; DataTable
//     never needs to know about permissions
//   - some cells carry conditional styling (StockPage: low-qty cells
//     get `font-semibold text-amber-700`) — `className` on the column,
//     or inline classes inside a column's own `render`, both work
//   - some cells are links/images, not plain text (FnbPage's photo
//     links, ShiftsPage's map embeds) — `render` returns arbitrary
//     ReactNode, not just a string
//
// Both the table and the stacked-card list render unconditionally; only
// CSS (`hidden md:block` / `md:hidden`) decides which one is visible —
// same approach AppShell's own mobile nav already uses (see that file's
// comment: "Tailwind's responsive classes have no effect in jsdom
// anyway... only in an actual browser"). This is not a double render for
// a real browser (only one side of a `display:none` pair is ever in the
// accessibility tree or visible), but it does mean a test asserting
// page content must scope its query to one side (e.g.
// `within(screen.getByRole('table'))`) rather than using a bare
// `getByText`, which would see the same text twice.
export interface DataTableColumn<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  /** Extra classes for this column's `<td>` (e.g. numeric alignment, conditional color). */
  className?: string;
  headerClassName?: string;
  /**
   * Omit this column's own label:value row on the mobile card — for a
   * column redundant with the card's title (see `mobileTitle`), or an
   * actions column (render those via `renderMobileActions` instead, so
   * they sit outside the label:value grid at the bottom of the card,
   * not inline with the data).
   */
  hideOnMobile?: boolean;
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  rows: T[] | 'loading' | 'error';
  rowKey: (row: T) => string;
  emptyMessage?: string;
  errorMessage?: string;
  loadingRows?: number;
  /** What titles each mobile card. Defaults to the first column's own `render(row)`. */
  mobileTitle?: (row: T) => ReactNode;
  /** Rendered at the bottom of each mobile card, outside the label:value grid. */
  renderMobileActions?: (row: T) => ReactNode;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  emptyMessage = 'Nothing here yet.',
  errorMessage = 'Could not load this list.',
  loadingRows = 3,
  mobileTitle,
  renderMobileActions,
}: DataTableProps<T>) {
  if (rows === 'loading') {
    return (
      <table className="w-full text-sm">
        <tbody>
          <SkeletonTableRows rows={loadingRows} columns={columns.length} />
        </tbody>
      </table>
    );
  }
  if (rows === 'error') {
    return <p role="alert">{errorMessage}</p>;
  }
  if (rows.length === 0) {
    return <EmptyState message={emptyMessage} />;
  }

  const [titleColumn, ...restColumns] = columns;
  const mobileFieldColumns = restColumns.filter((col) => !col.hideOnMobile);

  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="min-w-full text-left text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-ink-secondary">
              {columns.map((col) => (
                <th key={col.key} className={`py-2 pr-4 font-medium ${col.headerClassName ?? ''}`}>
                  {col.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={rowKey(row)} className="border-b border-gray-100">
                {columns.map((col) => (
                  <td key={col.key} className={`py-2 pr-4 ${col.className ?? ''}`}>
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="flex flex-col gap-3 md:hidden">
        {rows.map((row) => (
          <li key={rowKey(row)} className="flex flex-col gap-2 rounded-xl border border-gray-200 p-4">
            <p className="text-sm font-semibold text-ink">
              {mobileTitle ? mobileTitle(row) : titleColumn?.render(row)}
            </p>
            {mobileFieldColumns.map((col) => (
              <div key={col.key} className="flex items-baseline justify-between gap-3 text-sm">
                <span className="shrink-0 text-ink-muted">{col.header}</span>
                <span className="text-right text-ink">{col.render(row)}</span>
              </div>
            ))}
            {renderMobileActions && <div className="flex flex-wrap gap-3 pt-1">{renderMobileActions(row)}</div>}
          </li>
        ))}
      </ul>
    </>
  );
}
