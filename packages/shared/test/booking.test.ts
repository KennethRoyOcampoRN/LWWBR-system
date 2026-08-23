import { describe, expect, it } from 'vitest';
import { DEFAULT_BOOKING_WINDOW_SETTINGS, windowsConflict } from '../src/booking.js';

const d = (iso: string) => new Date(iso);

describe('windowsConflict (spec §7.5: datetime overlap + turnaround buffer)', () => {
  it('flags a direct overlap as a conflict, buffer or not', () => {
    expect(
      windowsConflict(d('2026-08-25T14:00:00Z'), d('2026-08-26T12:00:00Z'), d('2026-08-25T20:00:00Z'), d('2026-08-27T12:00:00Z'), 0),
    ).toBe(true);
  });

  it('allows two back-to-back windows with no gap at all when turnaroundMinutes is 0', () => {
    expect(windowsConflict(d('2026-08-25T09:00:00Z'), d('2026-08-25T17:00:00Z'), d('2026-08-25T17:00:00Z'), d('2026-08-25T20:00:00Z'), 0)).toBe(
      false,
    );
  });

  it('flags a conflict when the gap between two non-overlapping windows is smaller than the turnaround buffer', () => {
    // Day tour ends 17:00, next booking starts 17:30 — only 30 minutes of
    // gap, less than the default 60-minute turnaround buffer. This is
    // spec's own example: "the system will cheerfully double-book across
    // the 17:00 day-tour end and a same-evening arrival" without the rule.
    expect(
      windowsConflict(
        d('2026-08-25T09:00:00+08:00'),
        d('2026-08-25T17:00:00+08:00'),
        d('2026-08-25T17:30:00+08:00'),
        d('2026-08-26T12:00:00+08:00'),
        DEFAULT_BOOKING_WINDOW_SETTINGS.turnaroundMinutes,
      ),
    ).toBe(true);
  });

  it('allows two windows separated by exactly the turnaround buffer', () => {
    expect(
      windowsConflict(
        d('2026-08-25T09:00:00+08:00'),
        d('2026-08-25T17:00:00+08:00'),
        d('2026-08-25T18:00:00+08:00'),
        d('2026-08-26T12:00:00+08:00'),
        60,
      ),
    ).toBe(false);
  });

  it('allows two windows well clear of each other with plenty of gap', () => {
    expect(windowsConflict(d('2026-08-20T14:00:00Z'), d('2026-08-21T12:00:00Z'), d('2026-08-25T14:00:00Z'), d('2026-08-26T12:00:00Z'), 60)).toBe(
      false,
    );
  });

  it('applies the buffer symmetrically — a later window starting soon before an earlier one also conflicts', () => {
    // The mirror of spec's literal example: this time the *new* booking
    // is the one scheduled earlier, ending too close to an
    // already-scheduled later booking. Same housekeeping-gap reasoning
    // applies regardless of which one is "new".
    expect(
      windowsConflict(
        d('2026-08-25T17:30:00+08:00'),
        d('2026-08-26T12:00:00+08:00'),
        d('2026-08-25T09:00:00+08:00'),
        d('2026-08-25T17:00:00+08:00'),
        60,
      ),
    ).toBe(true);
  });

  it('a day-tour window nested inside a longer overnight stay on the same unit conflicts (real-world impossible, but the math must still say so)', () => {
    expect(
      windowsConflict(d('2026-08-25T14:00:00+08:00'), d('2026-08-27T12:00:00+08:00'), d('2026-08-26T09:00:00+08:00'), d('2026-08-26T17:00:00+08:00'), 60),
    ).toBe(true);
  });
});
