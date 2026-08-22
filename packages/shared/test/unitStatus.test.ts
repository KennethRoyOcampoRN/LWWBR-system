import { describe, expect, it } from 'vitest';
import {
  allowedManualTransitions,
  canTransition,
  getTransition,
  UNIT_STATUS_KEYS,
  UNIT_STATUS_TRANSITIONS,
} from '../src/unitStatus.js';

describe('unit status transition table (spec §7.1)', () => {
  it('follows the main cycle in order', () => {
    expect(canTransition('VACANT_DIRTY', 'CLEANING')).toBe(true);
    expect(canTransition('CLEANING', 'CLEANED')).toBe(true);
    expect(canTransition('CLEANED', 'INSPECTED')).toBe(true);
    expect(canTransition('INSPECTED', 'READY')).toBe(true);
    expect(canTransition('READY', 'OCCUPIED')).toBe(true);
    expect(canTransition('OCCUPIED', 'VACANT_DIRTY')).toBe(true);
  });

  it('rejects skipping a step in the main cycle', () => {
    expect(canTransition('VACANT_DIRTY', 'CLEANED')).toBe(false);
    expect(canTransition('CLEANING', 'INSPECTED')).toBe(false);
    expect(canTransition('CLEANED', 'READY')).toBe(false);
  });

  it('rejects going backwards', () => {
    expect(canTransition('CLEANED', 'CLEANING')).toBe(false);
    expect(canTransition('OCCUPIED', 'READY')).toBe(false);
  });

  it('allows OUT_OF_ORDER and BLOCKED from almost every state, both returning only to VACANT_DIRTY', () => {
    for (const status of UNIT_STATUS_KEYS) {
      if (status === 'OUT_OF_ORDER' || status === 'BLOCKED') continue;
      if (status === 'OCCUPIED') {
        // Spec doesn't list BLOCKED as reachable from an occupied unit —
        // you can't declare a guest's room "closed for renovation."
        expect(canTransition(status, 'OUT_OF_ORDER')).toBe(true);
        continue;
      }
      expect(canTransition(status, 'OUT_OF_ORDER')).toBe(true);
      expect(canTransition(status, 'BLOCKED')).toBe(true);
    }
    expect(UNIT_STATUS_TRANSITIONS.OUT_OF_ORDER.map((t) => t.to)).toEqual(['VACANT_DIRTY']);
    expect(UNIT_STATUS_TRANSITIONS.BLOCKED.map((t) => t.to)).toEqual(['VACANT_DIRTY']);
  });

  it('requires workorder:verify specifically for the QC step, per spec', () => {
    expect(getTransition('CLEANED', 'INSPECTED')?.permission).toBe('workorder:verify');
  });

  it('marks the three booking/inspection-driven transitions as automatic, not manual', () => {
    expect(getTransition('INSPECTED', 'READY')?.trigger).toBe('automatic');
    expect(getTransition('READY', 'OCCUPIED')?.trigger).toBe('automatic');
    expect(getTransition('OCCUPIED', 'VACANT_DIRTY')?.trigger).toBe('automatic');
  });
});

describe('allowedManualTransitions', () => {
  it('returns only manual transitions the given permissions actually grant', () => {
    // Holds unit:update_status but not workorder:verify or unit:block.
    const roomAttendantish = { 'unit:update_status': 'ALL' };
    expect(allowedManualTransitions('CLEANING', roomAttendantish)).toEqual(['CLEANED']);
    expect(allowedManualTransitions('CLEANED', roomAttendantish)).toEqual([]);
  });

  it('never includes automatic-only transitions, even for a caller with unit:manage', () => {
    const admin = { 'unit:manage': 'ALL', 'unit:block': 'ALL', 'unit:update_status': 'ALL', 'workorder:verify': 'ALL' };
    expect(allowedManualTransitions('INSPECTED', admin)).not.toContain('READY');
  });

  it('returns an empty list when the caller holds none of the required permissions', () => {
    expect(allowedManualTransitions('VACANT_DIRTY', {})).toEqual([]);
  });
});
