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

describe('BOOKING_TRANSITIONS (redesign 2026-08-24, partially reversed 2026-11-05 — spec.md §13 decision 16)', () => {
  it('allows CHECKED_IN to check out, requiring booking:checkout', () => {
    expect(canTransitionBooking('CHECKED_IN', 'CHECKED_OUT')).toBe(true);
    expect(getBookingTransition('CHECKED_IN', 'CHECKED_OUT')?.permission).toBe('booking:checkout');
  });

  it('rejects checking out twice, or checking a CHECKED_OUT booking back in', () => {
    expect(canTransitionBooking('CHECKED_OUT', 'CHECKED_OUT')).toBe(false);
    expect(canTransitionBooking('CHECKED_OUT', 'CHECKED_IN')).toBe(false);
  });

  // Decision 16: the Cashier tab's pre-arrival flow resurrects CONFIRMED
  // as a real, reachable state — a booking created by the new
  // pre-arrival endpoint, resolved one of three ways by a manual
  // front-desk action, all gated booking:checkin (same actor profile as
  // check-in itself).
  it('CONFIRMED can resolve to CHECKED_IN, CANCELLED, or NO_SHOW, all requiring booking:checkin', () => {
    expect(canTransitionBooking('CONFIRMED', 'CHECKED_IN')).toBe(true);
    expect(canTransitionBooking('CONFIRMED', 'CANCELLED')).toBe(true);
    expect(canTransitionBooking('CONFIRMED', 'NO_SHOW')).toBe(true);
    expect(getBookingTransition('CONFIRMED', 'CHECKED_IN')?.permission).toBe('booking:checkin');
    expect(getBookingTransition('CONFIRMED', 'CANCELLED')?.permission).toBe('booking:checkin');
    expect(getBookingTransition('CONFIRMED', 'NO_SHOW')?.permission).toBe('booking:checkin');
  });

  it('PENDING stays legacy — nothing in the pre-arrival flow needs a step before CONFIRMED', () => {
    expect(BOOKING_TRANSITIONS.PENDING).toEqual([]);
  });

  it('CHECKED_OUT, CANCELLED, and NO_SHOW are all terminal', () => {
    expect(BOOKING_TRANSITIONS.CHECKED_OUT).toEqual([]);
    expect(BOOKING_TRANSITIONS.CANCELLED).toEqual([]);
    expect(BOOKING_TRANSITIONS.NO_SHOW).toEqual([]);
  });

  it('degrades to no transitions available, not a crash, for an unrecognized `from` status', () => {
    const bogus = 'NOT_A_REAL_STATUS' as BookingStatusKey;
    expect(() => getBookingTransition(bogus, 'CHECKED_OUT')).not.toThrow();
    expect(canTransitionBooking(bogus, 'CHECKED_OUT')).toBe(false);
  });
});

// Decision 16: NO_SHOW now participates the same way CANCELLED/
// CHECKED_OUT already did — a booking in any of these states no longer
// has an open folio or holds its unit.
describe('BOOKING_STATUSES_EXCLUDED_FROM_AVAILABILITY', () => {
  it('includes CANCELLED, CHECKED_OUT, and NO_SHOW', async () => {
    const { BOOKING_STATUSES_EXCLUDED_FROM_AVAILABILITY } = await import('../src/booking.js');
    expect(BOOKING_STATUSES_EXCLUDED_FROM_AVAILABILITY).toEqual(
      expect.arrayContaining(['CANCELLED', 'CHECKED_OUT', 'NO_SHOW']),
    );
    expect(BOOKING_STATUSES_EXCLUDED_FROM_AVAILABILITY).toHaveLength(3);
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
