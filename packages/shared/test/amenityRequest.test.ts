import { describe, expect, it } from 'vitest';
import {
  allowedAmenityRequestTransitions,
  canViewAmenityUtilisationReport,
  getAmenityRequestTransition,
  type AmenityRequestStatusKey,
} from '../src/amenityRequest.js';

function canTransition(from: AmenityRequestStatusKey, to: AmenityRequestStatusKey): boolean {
  return getAmenityRequestTransition(from, to) !== undefined;
}

describe('amenity request transition table (spec §7.4)', () => {
  it('follows the main lifecycle in order', () => {
    expect(canTransition('REQUESTED', 'APPROVED')).toBe(true);
    expect(canTransition('APPROVED', 'ISSUED')).toBe(true);
    expect(canTransition('ISSUED', 'RETURNED')).toBe(true);
  });

  it('rejects skipping a step', () => {
    expect(canTransition('REQUESTED', 'ISSUED')).toBe(false);
    expect(canTransition('REQUESTED', 'RETURNED')).toBe(false);
    expect(canTransition('APPROVED', 'RETURNED')).toBe(false);
  });

  it('rejects going backwards', () => {
    expect(canTransition('ISSUED', 'APPROVED')).toBe(false);
    expect(canTransition('RETURNED', 'ISSUED')).toBe(false);
  });

  // Judgment call, not a client confirmation (see amenityRequest.ts's own
  // header comment): spec's diagram only draws CANCELLED from APPROVED,
  // but a REQUESTED-but-not-yet-approved request needs a withdraw path
  // too, by the same reasoning already confirmed for WorkOrder's
  // OPEN -> CANCELLED gap.
  it('allows CANCELLED from both REQUESTED and APPROVED, both gated on amenity:approve', () => {
    expect(canTransition('REQUESTED', 'CANCELLED')).toBe(true);
    expect(canTransition('APPROVED', 'CANCELLED')).toBe(true);
    expect(getAmenityRequestTransition('REQUESTED', 'CANCELLED')?.permission).toBe('amenity:approve');
    expect(getAmenityRequestTransition('APPROVED', 'CANCELLED')?.permission).toBe('amenity:approve');
  });

  it('allows OVERDUE -> RETURNED and OVERDUE -> LOST_DAMAGED, both gated on amenity:return', () => {
    expect(canTransition('OVERDUE', 'RETURNED')).toBe(true);
    expect(canTransition('OVERDUE', 'LOST_DAMAGED')).toBe(true);
    expect(getAmenityRequestTransition('OVERDUE', 'RETURNED')?.permission).toBe('amenity:return');
    expect(getAmenityRequestTransition('OVERDUE', 'LOST_DAMAGED')?.permission).toBe('amenity:return');
  });

  // ISSUED -> OVERDUE is deliberately absent from this table — it's the
  // one fully automatic transition, driven only by the sweep job
  // (POST /jobs/amenity-overdue), never reachable through the manual
  // status-change endpoint this table gates.
  it('has no manual path from ISSUED to OVERDUE — that transition is automatic-only', () => {
    expect(canTransition('ISSUED', 'OVERDUE')).toBe(false);
  });

  it('is terminal at RETURNED, CANCELLED, and LOST_DAMAGED', () => {
    expect(allowedAmenityRequestTransitions('RETURNED', { 'amenity:approve': 'ALL', 'amenity:return': 'ALL' })).toEqual([]);
    expect(allowedAmenityRequestTransitions('CANCELLED', { 'amenity:approve': 'ALL', 'amenity:return': 'ALL' })).toEqual([]);
    expect(allowedAmenityRequestTransitions('LOST_DAMAGED', { 'amenity:approve': 'ALL', 'amenity:return': 'ALL' })).toEqual([]);
  });

  it('allowedAmenityRequestTransitions filters by held permissions', () => {
    expect(allowedAmenityRequestTransitions('REQUESTED', { 'amenity:approve': 'ALL' })).toEqual(['APPROVED', 'CANCELLED']);
    expect(allowedAmenityRequestTransitions('REQUESTED', {})).toEqual([]);
    expect(allowedAmenityRequestTransitions('APPROVED', { 'amenity:issue': 'ALL' })).toEqual(['ISSUED']);
  });
});

// Client decision, 2026-08-26: the amenity utilisation & loss/damage
// report is gated by oversight role, not report:view's ordinary scope
// split — see canViewAmenityUtilisationReport's own header comment for
// the full reasoning.
describe('canViewAmenityUtilisationReport', () => {
  it('always allows SYSTEM_ADMIN and RESORT_MANAGER', () => {
    expect(canViewAmenityUtilisationReport(['SYSTEM_ADMIN'])).toBe(true);
    expect(canViewAmenityUtilisationReport(['RESORT_MANAGER'])).toBe(true);
  });

  it('allows POC_HOUSEKEEPING, the one department-POC role that currently holds amenity:approve', () => {
    expect(canViewAmenityUtilisationReport(['POC_HOUSEKEEPING'])).toBe(true);
  });

  it('refuses POC_MAINTENANCE and RESTAURANT_MANAGER — department POCs, but neither holds amenity:manage/amenity:approve', () => {
    expect(canViewAmenityUtilisationReport(['POC_MAINTENANCE'])).toBe(false);
    expect(canViewAmenityUtilisationReport(['RESTAURANT_MANAGER'])).toBe(false);
  });

  it('refuses CASHIER despite holding amenity:approve — not a department POC role, so it does not qualify', () => {
    expect(canViewAmenityUtilisationReport(['CASHIER'])).toBe(false);
  });

  it('refuses OWNER, OPS_SAFETY_SUPERVISOR, and ADMIN_HEAD despite their own ALL-scope report:view', () => {
    expect(canViewAmenityUtilisationReport(['OWNER'])).toBe(false);
    expect(canViewAmenityUtilisationReport(['OPS_SAFETY_SUPERVISOR'])).toBe(false);
    expect(canViewAmenityUtilisationReport(['ADMIN_HEAD'])).toBe(false);
  });

  it('allows a multi-role user if any one of their roles qualifies', () => {
    expect(canViewAmenityUtilisationReport(['RESTAURANT_STAFF', 'SYSTEM_ADMIN'])).toBe(true);
  });
});
