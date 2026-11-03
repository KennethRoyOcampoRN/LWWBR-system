import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DataTable, type DataTableColumn } from '../src/components/DataTable.js';

interface Row {
  id: string;
  name: string;
  status: 'Active' | 'Inactive';
}

const rows: Row[] = [
  { id: 'row_1', name: 'Toilet Paper', status: 'Active' },
  { id: 'row_2', name: 'Dish Soap', status: 'Inactive' },
];

const columns: DataTableColumn<Row>[] = [
  { key: 'name', header: 'Name', render: (r) => r.name },
  { key: 'status', header: 'Status', render: (r) => r.status },
];

describe('DataTable', () => {
  it('renders a loading skeleton (no real row data, no stacked-card list) when rows="loading"', () => {
    render(<DataTable columns={columns} rows="loading" rowKey={(r) => r.id} />);
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(screen.queryByText('Toilet Paper')).not.toBeInTheDocument();
  });

  it('renders an alert with the error message when rows="error"', () => {
    render(
      <DataTable columns={columns} rows="error" rowKey={(r) => r.id} errorMessage="Could not load the catalog." />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load the catalog.');
  });

  it('renders the empty message when rows is an empty array', () => {
    render(<DataTable columns={columns} rows={[]} rowKey={(r) => r.id} emptyMessage="No stock items yet." />);
    expect(screen.getByText('No stock items yet.')).toBeInTheDocument();
  });

  it('renders a real <table> with a header row and every data row, scoped to the desktop table', () => {
    render(<DataTable columns={columns} rows={rows} rowKey={(r) => r.id} />);
    const table = screen.getByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'Name' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'Status' })).toBeInTheDocument();
    expect(within(table).getByText('Toilet Paper')).toBeInTheDocument();
    expect(within(table).getByText('Dish Soap')).toBeInTheDocument();
    // The desktop table is hidden below md, visible from md up.
    expect(table.parentElement).toHaveClass('hidden');
    expect(table.parentElement).toHaveClass('md:block');
  });

  it('also renders the same rows as a stacked card list, hidden from md up', () => {
    render(<DataTable columns={columns} rows={rows} rowKey={(r) => r.id} />);
    const list = screen.getByRole('list');
    expect(list).toHaveClass('md:hidden');
    // The first column (Name) becomes each card's title by default.
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByText('Toilet Paper')).toBeInTheDocument();
    // The remaining column (Status) renders as a label:value row.
    expect(within(items[0]!).getByText('Status')).toBeInTheDocument();
    expect(within(items[0]!).getByText('Active')).toBeInTheDocument();
  });

  it('supports a custom mobileTitle, independent of the first column', () => {
    render(
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        mobileTitle={(r) => `#${r.id}`}
      />,
    );
    const list = screen.getByRole('list');
    expect(within(list).getByText('#row_1')).toBeInTheDocument();
  });

  it('hides a column from the mobile card when hideOnMobile is set, but keeps it on desktop', () => {
    const colsWithHiddenActions: DataTableColumn<Row>[] = [
      ...columns,
      { key: 'actions', header: 'Actions', render: () => 'Delete', hideOnMobile: true },
    ];
    render(<DataTable columns={colsWithHiddenActions} rows={rows} rowKey={(r) => r.id} />);
    const table = screen.getByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'Actions' })).toBeInTheDocument();

    const list = screen.getByRole('list');
    expect(within(list).queryByText('Actions')).not.toBeInTheDocument();
  });

  it('renders renderMobileActions at the bottom of each mobile card, outside the field grid', () => {
    render(
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        renderMobileActions={(r) => <button>Delete {r.name}</button>}
      />,
    );
    const list = screen.getByRole('list');
    const items = within(list).getAllByRole('listitem');
    expect(within(items[0]!).getByRole('button', { name: 'Delete Toilet Paper' })).toBeInTheDocument();
    // Desktop table never renders renderMobileActions.
    const table = screen.getByRole('table');
    expect(within(table).queryByRole('button')).not.toBeInTheDocument();
  });

  it('applies a column\'s className to its desktop cell', () => {
    const colsWithClass: DataTableColumn<Row>[] = [
      { key: 'name', header: 'Name', render: (r) => r.name, className: 'font-semibold text-amber-700' },
    ];
    render(<DataTable columns={colsWithClass} rows={rows} rowKey={(r) => r.id} />);
    const table = screen.getByRole('table');
    const cell = within(table).getByText('Toilet Paper');
    expect(cell).toHaveClass('text-amber-700');
  });
});
