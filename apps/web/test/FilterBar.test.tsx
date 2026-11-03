import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FilterBar } from '../src/components/FilterBar.js';

describe('FilterBar', () => {
  it('renders every field passed to it', () => {
    render(
      <FilterBar>
        <label>
          From
          <input />
        </label>
        <label>
          To
          <input />
        </label>
      </FilterBar>,
    );
    expect(screen.getByLabelText('From')).toBeInTheDocument();
    expect(screen.getByLabelText('To')).toBeInTheDocument();
  });

  it('wraps children in a flex-wrap row', () => {
    const { container } = render(
      <FilterBar>
        <span>a</span>
      </FilterBar>,
    );
    expect(container.firstElementChild).toHaveClass('flex-wrap');
  });
});
