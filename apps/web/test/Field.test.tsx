import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Field } from '../src/components/Field.js';

describe('Field', () => {
  it('associates the label with the input via getByLabelText', () => {
    render(
      <Field label="Name">
        <input />
      </Field>,
    );
    expect(screen.getByLabelText('Name')).toBeInTheDocument();
  });

  it('renders an error message instead of the hint when both are given', () => {
    render(
      <Field label="Name" hint="e.g. Dish Soap" error="Name is required.">
        <input />
      </Field>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Name is required.');
    expect(screen.queryByText('e.g. Dish Soap')).not.toBeInTheDocument();
  });

  it('renders the hint when there is no error', () => {
    render(
      <Field label="Name" hint="e.g. Dish Soap">
        <input />
      </Field>,
    );
    expect(screen.getByText('e.g. Dish Soap')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  // Real bug, caught converting StockPage to this primitive: a hint
  // sibling inside the same <label> as the label text polluted the
  // accessible name an implicit label computes (concatenates all text
  // content), so `getByLabelText('Unit of measure')` broke the moment
  // a hint was added — the real name became "Unit of measure e.g.
  // pack, bottle, pcs". Fixed by moving hint/error outside the <label>.
  it('keeps the label\'s accessible name exactly the label text, even with a hint present', () => {
    render(
      <Field label="Unit of measure" hint="e.g. pack, bottle, pcs">
        <input />
      </Field>,
    );
    expect(screen.getByLabelText('Unit of measure')).toBeInTheDocument();
    expect(screen.getByText('e.g. pack, bottle, pcs')).toBeInTheDocument();
  });

  it('renders neither hint nor error when neither is given', () => {
    render(
      <Field label="Name">
        <input />
      </Field>,
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
