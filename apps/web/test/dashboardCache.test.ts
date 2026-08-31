import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadDashboardSnapshot, saveDashboardSnapshot } from '../src/lib/dashboardCache.js';

describe('dashboardCache', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('returns null when nothing has ever been cached', () => {
    expect(loadDashboardSnapshot()).toBeNull();
  });

  it('saves and reads back a snapshot with a cachedAt timestamp', () => {
    saveDashboardSnapshot({ dashboard: { occupied: 3 }, feed: [{ id: 'e1' }] });
    const snapshot = loadDashboardSnapshot<{ occupied: number }, { id: string }[]>();
    expect(snapshot?.dashboard).toEqual({ occupied: 3 });
    expect(snapshot?.feed).toEqual([{ id: 'e1' }]);
    expect(snapshot?.cachedAt).toBeTruthy();
  });

  it('merges a partial save with the existing snapshot rather than overwriting it', () => {
    saveDashboardSnapshot({ dashboard: { occupied: 3 } });
    saveDashboardSnapshot({ feed: [{ id: 'e1' }] });

    const snapshot = loadDashboardSnapshot<{ occupied: number }, { id: string }[]>();
    expect(snapshot?.dashboard).toEqual({ occupied: 3 });
    expect(snapshot?.feed).toEqual([{ id: 'e1' }]);
  });

  it('a later save overwrites only the field it provides', () => {
    saveDashboardSnapshot({ dashboard: { occupied: 3 }, feed: [{ id: 'e1' }] });
    saveDashboardSnapshot({ dashboard: { occupied: 5 } });

    const snapshot = loadDashboardSnapshot<{ occupied: number }, { id: string }[]>();
    expect(snapshot?.dashboard).toEqual({ occupied: 5 });
    expect(snapshot?.feed).toEqual([{ id: 'e1' }]);
  });

  it('never throws when localStorage itself throws (private browsing / quota exceeded)', () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });

    expect(() => saveDashboardSnapshot({ dashboard: { occupied: 1 } })).not.toThrow();

    setItemSpy.mockRestore();
  });

  it('returns null (rather than throwing) if localStorage.getItem throws', () => {
    const getItemSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });

    expect(() => loadDashboardSnapshot()).not.toThrow();
    expect(loadDashboardSnapshot()).toBeNull();

    getItemSpy.mockRestore();
  });

  it('returns null (rather than throwing) if the stored value is corrupt JSON', () => {
    window.localStorage.setItem('lwwbr.dashboardSnapshot.v1', '{not valid json');
    expect(loadDashboardSnapshot()).toBeNull();
  });
});
