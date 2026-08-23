import { describe, expect, it } from 'vitest';
import {
  allowedManualTransitions,
  allowedOverrideTransitions,
  canOverrideAutomaticTransition,
  canTransition,
  getTransition,
  RETIRED_UNIT_STATUS_KEYS,
  UNIT_STATUS_KEYS,
  UNIT_STATUS_TRANSITIONS,
  type UnitStatusKey,
} from '../src/unitStatus.js';

describe('unit status transition table (spec §7.1, revised 2026-08-22: INSPECTED retired)', () => {
  it('follows the 5-state main cycle in order', () => {
    expect(canTransition('VACANT_DIRTY', 'CLEANING')).toBe(true);
    expect(canTransition('CLEANING', 'CLEANED')).toBe(true);
    expect(canTransition('CLEANED', 'READY')).toBe(true);
    expect(canTransition('READY', 'OCCUPIED')).toBe(true);
    expect(canTransition('OCCUPIED', 'VACANT_DIRTY')).toBe(true);
  });

  it('rejects skipping a step in the main cycle', () => {
    expect(canTransition('VACANT_DIRTY', 'CLEANED')).toBe(false);
    expect(canTransition('VACANT_DIRTY', 'READY')).toBe(false);
    expect(canTransition('CLEANING', 'READY')).toBe(false);
  });

  it('rejects going backwards', () => {
    expect(canTransition('CLEANED', 'CLEANING')).toBe(false);
    expect(canTransition('OCCUPIED', 'READY')).toBe(false);
  });

  it('no longer has INSPECTED anywhere in the forward-looking status list', () => {
    expect(UNIT_STATUS_KEYS).not.toContain('INSPECTED');
    // Retired, not forgotten — still its own list, for historical display
    // code (the timeline) to type against, just never reachable going
    // forward. See unitStatus.ts's RETIRED_UNIT_STATUS_KEYS comment.
    expect(RETIRED_UNIT_STATUS_KEYS).toEqual(['INSPECTED']);
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

  it('CLEANED -> READY is now a normal manual transition gated by unit:update_status, not workorder:verify', () => {
    // Client decision, 2026-08-22: the person who cleans the room is the
    // same person who marks it ready — no separate QC handoff, so this
    // uses the same housekeeping permission as the two transitions
    // before it in the cycle, and is no longer automatic-only.
    const readyTransition = getTransition('CLEANED', 'READY');
    expect(readyTransition?.permission).toBe('unit:update_status');
    expect(readyTransition?.trigger).toBe('manual');
  });

  it('marks only the two booking-driven transitions as automatic (down from three before INSPECTED was retired)', () => {
    expect(getTransition('READY', 'OCCUPIED')?.trigger).toBe('automatic');
    expect(getTransition('OCCUPIED', 'VACANT_DIRTY')?.trigger).toBe('automatic');
    expect(UNIT_STATUS_TRANSITIONS.CLEANED.every((t) => t.trigger === 'manual')).toBe(true);
  });

  it('never resolves a transition into the retired INSPECTED status', () => {
    // Cast needed since 'INSPECTED' is deliberately no longer a valid
    // UnitStatusKey — this proves nothing in the table can produce it.
    expect(canTransition('CLEANED', 'INSPECTED' as UnitStatusKey)).toBe(false);
  });

  it('a stale/retired `from` status degrades to no transitions available, rather than throwing', () => {
    // A live Unit row can still hold INSPECTED until someone force-
    // corrects it after this deploy (Postgres can't cleanly drop an
    // enum value already referenced by data, so it stays in the Prisma
    // enum). getTransition/canTransition must not crash on it.
    const retired = 'INSPECTED' as UnitStatusKey;
    expect(() => getTransition(retired, 'READY')).not.toThrow();
    expect(getTransition(retired, 'READY')).toBeUndefined();
    expect(canTransition(retired, 'READY')).toBe(false);
  });
});

describe('allowedManualTransitions', () => {
  it('returns only manual transitions the given permissions actually grant', () => {
    const housekeeping = { 'unit:update_status': 'ALL' };
    expect(allowedManualTransitions('CLEANING', housekeeping)).toEqual(['CLEANED']);
    expect(allowedManualTransitions('CLEANED', housekeeping)).toEqual(['READY']);
  });

  it('never includes automatic-only transitions, even for a caller with unit:manage', () => {
    const admin = { 'unit:manage': 'ALL', 'unit:block': 'ALL', 'unit:update_status': 'ALL' };
    expect(allowedManualTransitions('READY', admin)).not.toContain('OCCUPIED');
  });

  it('returns an empty list when the caller holds none of the required permissions', () => {
    expect(allowedManualTransitions('VACANT_DIRTY', {})).toEqual([]);
  });

  it('degrades to an empty list, not a crash, for a stale/retired `from` status', () => {
    const retired = 'INSPECTED' as UnitStatusKey;
    expect(() => allowedManualTransitions(retired, { 'unit:manage': 'ALL' })).not.toThrow();
    expect(allowedManualTransitions(retired, { 'unit:manage': 'ALL' })).toEqual([]);
  });
});

describe('canOverrideAutomaticTransition / allowedOverrideTransitions', () => {
  it('allows SYSTEM_ADMIN to override both remaining automatic transitions', () => {
    expect(canOverrideAutomaticTransition(['SYSTEM_ADMIN'])).toBe(true);
    expect(allowedOverrideTransitions('READY', ['SYSTEM_ADMIN'])).toEqual(['OCCUPIED']);
    expect(allowedOverrideTransitions('OCCUPIED', ['SYSTEM_ADMIN'])).toEqual(['VACANT_DIRTY']);
  });

  it('excludes RESORT_MANAGER, even though it holds unit:manage same as SYSTEM_ADMIN', () => {
    expect(canOverrideAutomaticTransition(['RESORT_MANAGER'])).toBe(false);
    expect(allowedOverrideTransitions('READY', ['RESORT_MANAGER'])).toEqual([]);
  });

  it('CLEANED no longer offers an override at all — its only automatic-only transition was retired with INSPECTED', () => {
    expect(allowedOverrideTransitions('CLEANED', ['SYSTEM_ADMIN'])).toEqual([]);
  });

  it('returns nothing for a status with no automatic transition at all', () => {
    expect(allowedOverrideTransitions('VACANT_DIRTY', ['SYSTEM_ADMIN'])).toEqual([]);
  });

  it('is true if SYSTEM_ADMIN is any one of several held roles', () => {
    expect(canOverrideAutomaticTransition(['CASHIER', 'SYSTEM_ADMIN'])).toBe(true);
  });

  it('degrades to an empty list, not a crash, for a stale/retired `from` status', () => {
    const retired = 'INSPECTED' as UnitStatusKey;
    expect(() => allowedOverrideTransitions(retired, ['SYSTEM_ADMIN'])).not.toThrow();
    expect(allowedOverrideTransitions(retired, ['SYSTEM_ADMIN'])).toEqual([]);
  });
});
