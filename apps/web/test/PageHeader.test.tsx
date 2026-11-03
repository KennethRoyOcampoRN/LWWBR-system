import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PageHeader } from '../src/components/PageHeader.js';

describe('PageHeader', () => {
  it('renders the title as a real heading', () => {
    render(<PageHeader title="Stock" />);
    expect(screen.getByRole('heading', { name: 'Stock', level: 1 })).toBeInTheDocument();
  });

  it('renders an optional description', () => {
    render(<PageHeader title="Stock" description="Catalog and movements." />);
    expect(screen.getByText('Catalog and movements.')).toBeInTheDocument();
  });

  it('renders no description paragraph when none is passed', () => {
    const { container } = render(<PageHeader title="Stock" />);
    expect(container.querySelectorAll('p')).toHaveLength(0);
  });

  it('renders an optional actions slot', () => {
    render(<PageHeader title="Stock" actions={<button>Add item</button>} />);
    expect(screen.getByRole('button', { name: 'Add item' })).toBeInTheDocument();
  });
});
