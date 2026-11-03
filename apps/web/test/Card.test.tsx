import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Card, Section } from '../src/components/Card.js';

describe('Card', () => {
  it('renders children inside the shadow-card surface', () => {
    const { container } = render(<Card>Hello</Card>);
    expect(screen.getByText('Hello')).toBeInTheDocument();
    expect(container.firstElementChild).toHaveClass('shadow-card');
  });

  it('omits padding classes when padding="none"', () => {
    const { container } = render(<Card padding="none">Hello</Card>);
    expect(container.firstElementChild).not.toHaveClass('p-4');
  });
});

describe('Section', () => {
  it('renders a title as a heading, a description, and children', () => {
    render(
      <Section title="Catalog" description="Everything in stock.">
        <p>Row content</p>
      </Section>,
    );
    expect(screen.getByRole('heading', { name: 'Catalog' })).toBeInTheDocument();
    expect(screen.getByText('Everything in stock.')).toBeInTheDocument();
    expect(screen.getByText('Row content')).toBeInTheDocument();
  });

  it('renders an actions slot next to the title', () => {
    render(
      <Section title="Catalog" actions={<button>Add item</button>}>
        content
      </Section>,
    );
    expect(screen.getByRole('button', { name: 'Add item' })).toBeInTheDocument();
  });

  it('wraps content in the Card surface by default', () => {
    const { container } = render(<Section title="Catalog">content</Section>);
    expect(container.querySelector('.shadow-card')).not.toBeNull();
  });

  it('skips the Card surface when surface={false}', () => {
    const { container } = render(
      <Section title="Catalog" surface={false}>
        content
      </Section>,
    );
    expect(container.querySelector('.shadow-card')).toBeNull();
  });

  it('renders with no title/actions header when neither is passed', () => {
    render(<Section>just content</Section>);
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    expect(screen.getByText('just content')).toBeInTheDocument();
  });
});
