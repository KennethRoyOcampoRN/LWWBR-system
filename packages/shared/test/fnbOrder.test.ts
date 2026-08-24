import { describe, expect, it } from 'vitest';
import { allowedFnbOrderTransitions, getFnbOrderTransition, type FnbOrderStatusKey } from '../src/fnbOrder.js';

function canTransition(from: FnbOrderStatusKey, to: FnbOrderStatusKey): boolean {
  return getFnbOrderTransition(from, to) !== undefined;
}

describe('F&B order transition table (spec §7.3)', () => {
  it('follows the main lifecycle in order', () => {
    expect(canTransition('RECEIVED', 'PREPARING')).toBe(true);
    expect(canTransition('PREPARING', 'READY')).toBe(true);
    expect(canTransition('READY', 'SERVED')).toBe(true);
  });

  it('rejects skipping a step', () => {
    expect(canTransition('RECEIVED', 'READY')).toBe(false);
    expect(canTransition('RECEIVED', 'SERVED')).toBe(false);
    expect(canTransition('PREPARING', 'SERVED')).toBe(false);
  });

  it('rejects going backwards', () => {
    expect(canTransition('READY', 'PREPARING')).toBe(false);
    expect(canTransition('SERVED', 'READY')).toBe(false);
  });

  it('allows CANCELLED from RECEIVED and PREPARING, both gated on fnb:update_status', () => {
    expect(canTransition('RECEIVED', 'CANCELLED')).toBe(true);
    expect(canTransition('PREPARING', 'CANCELLED')).toBe(true);
    expect(getFnbOrderTransition('RECEIVED', 'CANCELLED')?.permission).toBe('fnb:update_status');
    expect(getFnbOrderTransition('PREPARING', 'CANCELLED')?.permission).toBe('fnb:update_status');
  });

  it('does not allow cancelling a READY or SERVED order', () => {
    expect(canTransition('READY', 'CANCELLED')).toBe(false);
    expect(canTransition('SERVED', 'CANCELLED')).toBe(false);
  });

  it('is terminal at SERVED and CANCELLED', () => {
    expect(allowedFnbOrderTransitions('SERVED', { 'fnb:update_status': 'ALL' })).toEqual([]);
    expect(allowedFnbOrderTransitions('CANCELLED', { 'fnb:update_status': 'ALL' })).toEqual([]);
  });

  it('allowedFnbOrderTransitions filters by held permissions', () => {
    expect(allowedFnbOrderTransitions('RECEIVED', { 'fnb:update_status': 'ALL' })).toEqual(['PREPARING', 'CANCELLED']);
    expect(allowedFnbOrderTransitions('RECEIVED', {})).toEqual([]);
  });
});
