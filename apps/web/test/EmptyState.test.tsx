import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EmptyState } from '../src/components/EmptyState.js';

describe('EmptyState', () => {
  it('renders the message', () => {
    render(<EmptyState message="No work orders yet." />);
    expect(screen.getByText('No work orders yet.')).toBeInTheDocument();
  });

  it('renders an optional action alongside the message', () => {
    render(<EmptyState message="No amenity items yet." action={<button>Add item</button>} />);
    expect(screen.getByText('No amenity items yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add item' })).toBeInTheDocument();
  });

  it('renders no action when none is passed', () => {
    render(<EmptyState message="Nothing here." />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
