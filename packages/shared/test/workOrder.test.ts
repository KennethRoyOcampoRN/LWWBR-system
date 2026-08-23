import { describe, expect, it } from 'vitest';
import {
  allowedWorkOrderTransitions,
  canTransitionWorkOrder,
  canVerifyWorkOrder,
  DEFAULT_WORK_ORDER_PHOTO_REQUIREMENTS,
  getWorkOrderTransition,
  WORK_ORDER_TRANSITIONS,
  type WorkOrderStatusKey,
} from '../src/workOrder.js';

describe('work order transition table (spec §7.2)', () => {
  it('follows the main lifecycle in order', () => {
    expect(canTransitionWorkOrder('OPEN', 'ASSIGNED')).toBe(true);
    expect(canTransitionWorkOrder('ASSIGNED', 'IN_PROGRESS')).toBe(true);
    expect(canTransitionWorkOrder('IN_PROGRESS', 'DONE')).toBe(true);
    expect(canTransitionWorkOrder('DONE', 'VERIFIED')).toBe(true);
  });

  it('rejects skipping a step', () => {
    expect(canTransitionWorkOrder('OPEN', 'IN_PROGRESS')).toBe(false);
    expect(canTransitionWorkOrder('OPEN', 'DONE')).toBe(false);
    expect(canTransitionWorkOrder('ASSIGNED', 'DONE')).toBe(false);
  });

  it('rejects going backwards', () => {
    expect(canTransitionWorkOrder('DONE', 'IN_PROGRESS')).toBe(false);
    expect(canTransitionWorkOrder('VERIFIED', 'DONE')).toBe(false);
  });

  it('allows CANCELLED from OPEN, ASSIGNED, and IN_PROGRESS — a ticket is cancellable any time before DONE', () => {
    // OPEN -> CANCELLED added 2026-08-23 (client decision): spec's own
    // diagram omitted it, flagged as a possible oversight rather than
    // silently assumed, and confirmed by the client to be exactly that —
    // a mis-filed or duplicate ticket shouldn't need to be assigned
    // before it can be cancelled.
    expect(canTransitionWorkOrder('OPEN', 'CANCELLED')).toBe(true);
    expect(canTransitionWorkOrder('ASSIGNED', 'CANCELLED')).toBe(true);
    expect(canTransitionWorkOrder('IN_PROGRESS', 'CANCELLED')).toBe(true);
    expect(getWorkOrderTransition('OPEN', 'CANCELLED')?.permission).toBe('workorder:close');
  });

  it('allows DONE -> REOPENED (QC fail) and REOPENED -> IN_PROGRESS, both gated correctly', () => {
    expect(getWorkOrderTransition('DONE', 'REOPENED')?.permission).toBe('workorder:verify');
    expect(getWorkOrderTransition('REOPENED', 'IN_PROGRESS')?.permission).toBe('workorder:update_status');
  });

  it('requires workorder:verify for both DONE outcomes (verify and reopen), per spec', () => {
    expect(getWorkOrderTransition('DONE', 'VERIFIED')?.permission).toBe('workorder:verify');
    expect(getWorkOrderTransition('DONE', 'REOPENED')?.permission).toBe('workorder:verify');
  });

  it('requires workorder:assign specifically for OPEN -> ASSIGNED', () => {
    expect(getWorkOrderTransition('OPEN', 'ASSIGNED')?.permission).toBe('workorder:assign');
  });

  it('requires workorder:close specifically for cancellation, from any cancellable state', () => {
    expect(getWorkOrderTransition('OPEN', 'CANCELLED')?.permission).toBe('workorder:close');
    expect(getWorkOrderTransition('ASSIGNED', 'CANCELLED')?.permission).toBe('workorder:close');
    expect(getWorkOrderTransition('IN_PROGRESS', 'CANCELLED')?.permission).toBe('workorder:close');
  });

  it('VERIFIED and CANCELLED are terminal', () => {
    expect(WORK_ORDER_TRANSITIONS.VERIFIED).toEqual([]);
    expect(WORK_ORDER_TRANSITIONS.CANCELLED).toEqual([]);
  });

  it('degrades to no transitions available, not a crash, for an unrecognized `from` status', () => {
    const bogus = 'NOT_A_REAL_STATUS' as WorkOrderStatusKey;
    expect(() => getWorkOrderTransition(bogus, 'ASSIGNED')).not.toThrow();
    expect(canTransitionWorkOrder(bogus, 'ASSIGNED')).toBe(false);
  });
});

describe('allowedWorkOrderTransitions', () => {
  it('returns only the transitions the given permissions actually grant', () => {
    const tech = { 'workorder:update_status': 'ALL' };
    expect(allowedWorkOrderTransitions('ASSIGNED', tech)).toEqual(['IN_PROGRESS']);
    expect(allowedWorkOrderTransitions('OPEN', tech)).toEqual([]);
  });

  it('returns both DONE outcomes for a caller holding workorder:verify', () => {
    const poc = { 'workorder:verify': 'ALL' };
    expect(allowedWorkOrderTransitions('DONE', poc)).toEqual(['VERIFIED', 'REOPENED']);
  });

  it('returns an empty list when the caller holds none of the required permissions', () => {
    expect(allowedWorkOrderTransitions('OPEN', {})).toEqual([]);
  });
});

describe('DEFAULT_WORK_ORDER_PHOTO_REQUIREMENTS (spec §7.2.1)', () => {
  it('requires an ISSUE photo on create and a COMPLETION photo on DONE for MAINTENANCE and SAFETY', () => {
    for (const type of ['MAINTENANCE', 'SAFETY'] as const) {
      expect(DEFAULT_WORK_ORDER_PHOTO_REQUIREMENTS[type].onCreate).toEqual(['ISSUE']);
      expect(DEFAULT_WORK_ORDER_PHOTO_REQUIREMENTS[type].onDone).toEqual(['COMPLETION']);
    }
  });

  it('requires a COMPLETION photo on DONE for DEEP_CLEAN, but no ISSUE photo on create', () => {
    expect(DEFAULT_WORK_ORDER_PHOTO_REQUIREMENTS.DEEP_CLEAN.onCreate).toEqual([]);
    expect(DEFAULT_WORK_ORDER_PHOTO_REQUIREMENTS.DEEP_CLEAN.onDone).toEqual(['COMPLETION']);
  });

  it('requires nothing for HOUSEKEEPING, AMENITY, or GENERAL — encouraged but not required per spec', () => {
    for (const type of ['HOUSEKEEPING', 'AMENITY', 'GENERAL'] as const) {
      expect(DEFAULT_WORK_ORDER_PHOTO_REQUIREMENTS[type].onCreate).toEqual([]);
      expect(DEFAULT_WORK_ORDER_PHOTO_REQUIREMENTS[type].onDone).toEqual([]);
    }
  });
});

describe('canVerifyWorkOrder (spec §7.2: "only the department POC or above may verify")', () => {
  it('allows a department POC to verify their own department\'s ticket', () => {
    expect(canVerifyWorkOrder(['POC_MAINTENANCE'], 'MAINTENANCE', 'MAINTENANCE')).toBe(true);
  });

  it('rejects a department POC verifying a different department\'s ticket', () => {
    expect(canVerifyWorkOrder(['POC_MAINTENANCE'], 'MAINTENANCE', 'HOUSEKEEPING')).toBe(false);
    expect(canVerifyWorkOrder(['POC_HOUSEKEEPING'], 'HOUSEKEEPING', 'MAINTENANCE')).toBe(false);
    expect(canVerifyWorkOrder(['RESTAURANT_MANAGER'], 'RESTAURANT', 'MAINTENANCE')).toBe(false);
  });

  it('allows SYSTEM_ADMIN, RESORT_MANAGER, and OPS_SAFETY_SUPERVISOR to verify any department — "or above"', () => {
    expect(canVerifyWorkOrder(['SYSTEM_ADMIN'], 'MANAGEMENT', 'MAINTENANCE')).toBe(true);
    expect(canVerifyWorkOrder(['RESORT_MANAGER'], 'MANAGEMENT', 'HOUSEKEEPING')).toBe(true);
    expect(canVerifyWorkOrder(['OPS_SAFETY_SUPERVISOR'], 'MANAGEMENT', 'RESTAURANT')).toBe(true);
  });

  it('is exempt if any one of several held roles is a management role', () => {
    expect(canVerifyWorkOrder(['POC_HOUSEKEEPING', 'SYSTEM_ADMIN'], 'HOUSEKEEPING', 'MAINTENANCE')).toBe(true);
  });
});
