import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Skeleton, SkeletonCard, SkeletonList, SkeletonTableRows } from '../src/components/Skeleton.js';

describe('Skeleton', () => {
  it('renders a single pulsing bar', () => {
    const { container } = render(<Skeleton className="h-4 w-20" />);
    const el = container.firstElementChild;
    expect(el).toHaveClass('animate-pulse');
    expect(el).toHaveClass('h-4');
    expect(el).toHaveClass('w-20');
  });
});

describe('SkeletonTableRows', () => {
  it('renders the default 3 rows x 4 columns inside a table', () => {
    const { container } = render(
      <table>
        <tbody>
          <SkeletonTableRows />
        </tbody>
      </table>,
    );
    expect(container.querySelectorAll('tr')).toHaveLength(3);
    expect(container.querySelectorAll('tr')[0]!.querySelectorAll('td')).toHaveLength(4);
  });

  it('respects a custom rows/columns count', () => {
    const { container } = render(
      <table>
        <tbody>
          <SkeletonTableRows rows={5} columns={2} />
        </tbody>
      </table>,
    );
    expect(container.querySelectorAll('tr')).toHaveLength(5);
    expect(container.querySelectorAll('tr')[0]!.querySelectorAll('td')).toHaveLength(2);
  });
});

describe('SkeletonList', () => {
  it('renders the default 3 items as list rows', () => {
    const { container } = render(<SkeletonList />);
    expect(container.querySelectorAll('li')).toHaveLength(3);
  });

  it('respects a custom item count', () => {
    const { container } = render(<SkeletonList items={6} />);
    expect(container.querySelectorAll('li')).toHaveLength(6);
  });
});

describe('SkeletonCard', () => {
  it('renders a bordered card with skeleton content', () => {
    const { container } = render(<SkeletonCard />);
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThanOrEqual(2);
  });
});
