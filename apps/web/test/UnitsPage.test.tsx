import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.js';

function jsonResponse(status: number, body: unknown) {
  return Promise.resolve({
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body),
  } as Response);
}

const managerUser = {
  id: 'user_1',
  employeeCode: 'LWW-001',
  fullName: 'Resort Manager (Demo)',
  email: null,
  department: 'MANAGEMENT',
  mustChangePassword: false,
  roles: ['RESORT_MANAGER'],
  permissions: { 'unit:read': 'ALL', 'unit:update_status': 'ALL', 'booking:checkin': 'ALL', 'booking:checkout': 'ALL' },
};

const room = { id: 'unit_1', code: 'R01', name: 'Room 1', unitTypeId: 't1', type: 'ROOM', capacity: 4, floor: null, status: 'READY', version: 0, notes: null, isActive: true, sortOrder: 0, latestNote: null };
const cottage = { id: 'unit_2', code: 'C01', name: 'Cottage 1', unitTypeId: 't2', type: 'COTTAGE', capacity: 6, floor: null, status: 'READY', version: 0, notes: null, isActive: true, sortOrder: 1, latestNote: null };
const pool = { id: 'unit_3', code: 'POOL', name: 'Pool', unitTypeId: 't3', type: 'FACILITY', capacity: 0, floor: null, status: 'READY', version: 0, notes: null, isActive: true, sortOrder: 2, latestNote: null };
const restroom = { id: 'unit_4', code: 'CR-F', name: 'CR-Female', unitTypeId: 't4', type: 'COMMON_AREA', capacity: 0, floor: null, status: 'READY', version: 0, notes: null, isActive: true, sortOrder: 3, latestNote: null };

describe('UnitsPage — Check-in room picker', () => {
  // Real bug found live-testing, 2026-08-25: common areas (Beach Front,
  // CR-Female/Male, Function Hall, Pool, Restaurant) were listed as
  // selectable check-in destinations alongside real accommodations.
  it('lists only ROOM/COTTAGE units, never COMMON_AREA/FACILITY ones', async () => {
    window.history.pushState({}, '', '/units');
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: managerUser });
      if (url.endsWith('/units')) return jsonResponse(200, { units: [room, cottage, pool, restroom] });
      if (url.endsWith('/unit-types')) return jsonResponse(200, { unitTypes: [] });
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => expect(screen.getByText('Rooms')).toBeInTheDocument());

    // The picker list is inside the "Rooms" <details> — scope the query
    // there so the main unit grid's own tiles (which do show POOL/CR-F)
    // aren't mistaken for picker entries.
    const picker = await waitFor(() => screen.getByText('Rooms').closest('details')!);
    await waitFor(() => expect(picker.textContent).toContain('R01'));
    expect(picker.textContent).toContain('R01');
    expect(picker.textContent).toContain('C01');
    expect(picker.textContent).not.toContain('POOL');
    expect(picker.textContent).not.toContain('CR-F');
    // 2 checkboxes: one per bookable unit, none for the two common areas.
    expect(picker.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
  });
});
