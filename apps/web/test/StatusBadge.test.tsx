import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatusBadge } from '../src/components/StatusBadge.js';

describe('StatusBadge', () => {
  it('renders its label text', () => {
    render(<StatusBadge variant="success">Active</StatusBadge>);
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  // Measured AA text contrast (see StatusBadge.tsx's own comment): the
  // -50/-600 tint pairing fails 4.5:1 for three of five semantic colors,
  // so this badge fills solid with -600 and uses white text instead —
  // assert that's actually what renders, for every variant, so a future
  // edit can't silently reintroduce the failing tint pairing.
  it.each(['success', 'warning', 'danger', 'info', 'accent'] as const)(
    'variant="%s" fills solid with white text, not the failing -50/-600 tint pairing',
    (variant) => {
      render(<StatusBadge variant={variant}>Label</StatusBadge>);
      const badge = screen.getByText('Label');
      expect(badge).toHaveClass(`bg-${variant}-600`);
      expect(badge).toHaveClass('text-white');
    },
  );

  it('variant="neutral" uses ink on gray-100', () => {
    render(<StatusBadge variant="neutral">Normal</StatusBadge>);
    const badge = screen.getByText('Normal');
    expect(badge).toHaveClass('bg-gray-100');
    expect(badge).toHaveClass('text-ink');
  });
});
