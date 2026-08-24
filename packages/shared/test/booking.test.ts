import { describe, expect, it } from 'vitest';
import {
  allowedBookingTransitions,
  BOOKING_TRANSITIONS,
  canTransitionBooking,
  getBookingTransition,
  type BookingStatusKey,
} from '../src/booking.js';

// windowsConflict/DEFAULT_BOOKING_WINDOW_SETTINGS/BookingWindowSettings
// are gone as of the 2026-08-24 redesign — this app no longer creates
// reservations or checks for overlapping windows, so there is no
// availability engine left to test. See booking.ts's own header comment.

describe('BOOKING_TRANSITIONS (redesign 2026-08-24: check-in creates the Booking row directly, already CHECKED_IN)', () => {
  it('allows CHECKED_IN to check out, requiring booking:checkout', () => {
    expect(canTransitionBooking('CHECKED_IN', 'CHECKED_OUT')).toBe(true);
    expect(getBookingTransition('CHECKED_IN', 'CHECKED_OUT')?.permission).toBe('booking:checkout');
  });

  it('rejects checking out twice, or checking a CHECKED_OUT booking back in', () => {
    expect(canTransitionBooking('CHECKED_OUT', 'CHECKED_OUT')).toBe(false);
    expect(canTransitionBooking('CHECKED_OUT', 'CHECKED_IN')).toBe(false);
  });

  it('PENDING/CONFIRMED/CANCELLED/NO_SHOW are all legacy — no endpoint can produce or act on any of them anymore', () => {
    expect(BOOKING_TRANSITIONS.PENDING).toEqual([]);
    expect(BOOKING_TRANSITIONS.CONFIRMED).toEqual([]);
    expect(BOOKING_TRANSITIONS.CANCELLED).toEqual([]);
    expect(BOOKING_TRANSITIONS.NO_SHOW).toEqual([]);
  });

  it('CHECKED_OUT is terminal', () => {
    expect(BOOKING_TRANSITIONS.CHECKED_OUT).toEqual([]);
  });

  it('degrades to no transitions available, not a crash, for an unrecognized `from` status', () => {
    const bogus = 'NOT_A_REAL_STATUS' as BookingStatusKey;
    expect(() => getBookingTransition(bogus, 'CHECKED_OUT')).not.toThrow();
    expect(canTransitionBooking(bogus, 'CHECKED_OUT')).toBe(false);
  });
});

describe('allowedBookingTransitions', () => {
  it('returns only the transitions the given permissions actually grant', () => {
    expect(allowedBookingTransitions('CHECKED_IN', { 'booking:checkout': 'ALL' })).toEqual(['CHECKED_OUT']);
    expect(allowedBookingTransitions('CHECKED_IN', {})).toEqual([]);
  });

  it('returns an empty list for a terminal status regardless of permissions held', () => {
    expect(allowedBookingTransitions('CHECKED_OUT', { 'booking:checkin': 'ALL', 'booking:checkout': 'ALL' })).toEqual([]);
  });
});
