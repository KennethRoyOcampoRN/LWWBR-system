import { describe, expect, it } from 'vitest';
import {
  isAudited,
  modelDelegateName,
  needsBeforeRead,
  redactSensitiveFields,
  resolveEntityId,
} from '../../src/lib/auditExtension.js';

describe('isAudited', () => {
  it('audits ordinary domain-model mutations', () => {
    expect(isAudited('WorkOrder', 'create')).toBe(true);
    expect(isAudited('User', 'update')).toBe(true);
    expect(isAudited('Booking', 'delete')).toBe(true);
    expect(isAudited('Payment', 'upsert')).toBe(true);
  });

  it('never audits AuditLog itself, to avoid recursive writes', () => {
    expect(isAudited('AuditLog', 'create')).toBe(false);
  });

  it('never audits Session — its own churn has explicit LOGIN_*/REFRESH_* entries instead', () => {
    expect(isAudited('Session', 'create')).toBe(false);
    expect(isAudited('Session', 'update')).toBe(false);
  });

  it('does not audit read or bulk operations', () => {
    expect(isAudited('User', 'findMany')).toBe(false);
    expect(isAudited('User', 'findUnique')).toBe(false);
    expect(isAudited('User', 'updateMany')).toBe(false);
    expect(isAudited('User', 'deleteMany')).toBe(false);
    expect(isAudited('User', 'count')).toBe(false);
  });

  it('is false with no model (e.g. raw queries)', () => {
    expect(isAudited(undefined, 'create')).toBe(false);
  });
});

describe('needsBeforeRead', () => {
  it('is true for update/delete/upsert, false for create', () => {
    expect(needsBeforeRead('update')).toBe(true);
    expect(needsBeforeRead('delete')).toBe(true);
    expect(needsBeforeRead('upsert')).toBe(true);
    expect(needsBeforeRead('create')).toBe(false);
  });
});

describe('resolveEntityId', () => {
  it('reads a string id off a record', () => {
    expect(resolveEntityId({ id: 'work_order_1', title: 'Leaky faucet' })).toBe('work_order_1');
  });

  it('returns null for records without a string id', () => {
    expect(resolveEntityId({ id: 42 })).toBeNull();
    expect(resolveEntityId({})).toBeNull();
    expect(resolveEntityId(null)).toBeNull();
    expect(resolveEntityId(undefined)).toBeNull();
    expect(resolveEntityId('not-an-object')).toBeNull();
  });
});

describe('redactSensitiveFields', () => {
  it('redacts passwordHash and refresh token hashes without touching other fields', () => {
    const record = {
      id: 'user_1',
      employeeCode: 'LWW-001',
      passwordHash: '$argon2id$...',
    };
    expect(redactSensitiveFields(record)).toEqual({
      id: 'user_1',
      employeeCode: 'LWW-001',
      passwordHash: '[redacted]',
    });
  });

  it('leaves records with no sensitive fields untouched', () => {
    const record = { id: 'unit_1', code: 'R01' };
    expect(redactSensitiveFields(record)).toEqual(record);
  });

  it('passes through non-objects unchanged', () => {
    expect(redactSensitiveFields(null)).toBeNull();
    expect(redactSensitiveFields(undefined)).toBeUndefined();
  });
});

describe('modelDelegateName', () => {
  it('lowercases the first letter of the Prisma model name', () => {
    expect(modelDelegateName('User')).toBe('user');
    expect(modelDelegateName('WorkOrder')).toBe('workOrder');
    expect(modelDelegateName('FnbOrder')).toBe('fnbOrder');
  });
});
