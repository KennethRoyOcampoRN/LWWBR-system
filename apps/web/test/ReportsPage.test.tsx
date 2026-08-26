import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.js';

function jsonResponse(status: number, body: unknown) {
  return Promise.resolve({
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body),
  } as Response);
}

function csvResponse(text: string) {
  return Promise.resolve({
    status: 200,
    ok: true,
    blob: () => Promise.resolve(new Blob([text], { type: 'text/csv' })),
  } as unknown as Response);
}

const managerUser = {
  id: 'user_1',
  employeeCode: 'LWW-001',
  fullName: 'Resort Manager (Demo)',
  email: null,
  department: 'MANAGEMENT',
  mustChangePassword: false,
  roles: ['RESORT_MANAGER'],
  permissions: { 'report:view': 'ALL', 'report:export': 'ALL' },
};

const viewOnlyDeptUser = {
  ...managerUser,
  id: 'user_2',
  department: 'HOUSEKEEPING',
  roles: ['POC_HOUSEKEEPING'],
  permissions: { 'report:view': 'DEPARTMENT' },
};

describe('ReportsPage', () => {
  beforeEach(() => {
    window.history.pushState({}, '', '/reports');
    URL.createObjectURL = vi.fn().mockReturnValue('blob:mock-url');
    URL.revokeObjectURL = vi.fn();
  });

  it('runs the work-orders report and shows the summary and detail rows', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: managerUser });
      if (url.includes('/reports/work-orders?')) {
        return jsonResponse(200, {
          report: {
            key: 'work-orders',
            from: '2026-08-24',
            to: '2026-08-25',
            summary: {
              totalVolume: 2,
              byType: [{ type: 'MAINTENANCE', count: 2 }],
              byDepartment: [{ department: 'MAINTENANCE', count: 2 }],
              avgTimeToCloseMinutes: 90,
              slaBreachedCount: 1,
              topRecurringUnits: [{ unitCode: 'R01', unitName: 'Room 1', count: 2 }],
            },
            rows: [
              {
                id: 'wo_1',
                referenceNo: 'WO-001',
                type: 'MAINTENANCE',
                department: 'MAINTENANCE',
                status: 'VERIFIED',
                unitCode: 'R01',
                unitName: 'Room 1',
                createdAt: '2026-08-24T10:00:00.000Z',
                dueAt: null,
                completedAt: null,
                verifiedAt: '2026-08-24T11:30:00.000Z',
                slaBreached: true,
                timeToCloseMinutes: 90,
              },
            ],
          },
        });
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Reports' })).toBeInTheDocument());
    await user.selectOptions(screen.getByLabelText('Report'), 'work-orders');
    await user.click(screen.getByRole('button', { name: 'Run report' }));

    await waitFor(() => expect(screen.getByText('WO-001')).toBeInTheDocument());
    expect(screen.getAllByText('1h 30m').length).toBeGreaterThan(0); // avg time to close tile + row
    expect(screen.getByText('Breached')).toBeInTheDocument();
  });

  it('runs the housekeeping report and shows attendant productivity, with no QC pass rate shown', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: managerUser });
      if (url.includes('/reports/housekeeping?')) {
        return jsonResponse(200, {
          report: {
            key: 'housekeeping',
            from: '2026-08-24',
            to: '2026-08-25',
            summary: {
              totalRoomsCleaned: 2,
              avgCleanTimeMinutes: 25,
              byAttendant: [
                { attendantId: 'user_a', attendantName: 'Attendant A', roomsCleaned: 2, avgCleanTimeMinutes: 25 },
              ],
            },
            rows: [
              {
                unitId: 'unit_1',
                unitCode: 'R01',
                unitName: 'Room 1',
                attendantId: 'user_a',
                attendantName: 'Attendant A',
                cleaningStartedAt: '2026-08-24T01:00:00.000Z',
                cleanedAt: '2026-08-24T01:30:00.000Z',
                cleanTimeMinutes: 30,
              },
            ],
          },
        });
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Reports' })).toBeInTheDocument());
    await user.selectOptions(screen.getByLabelText('Report'), 'housekeeping');
    await user.click(screen.getByRole('button', { name: 'Run report' }));

    await waitFor(() => expect(screen.getAllByText('Attendant A').length).toBeGreaterThan(0));
    expect(screen.getByText('Rooms cleaned').parentElement).toHaveTextContent('2');
    expect(screen.getByText(/2 rooms · avg 25m/)).toBeInTheDocument();
    expect(screen.getByText(/QC pass rate isn't shown/)).toBeInTheDocument();
  });

  it('exports the current report to CSV', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: managerUser });
      if (url.includes('/reports/occupancy?')) {
        return jsonResponse(200, {
          report: {
            key: 'occupancy',
            from: '2026-08-24',
            to: '2026-08-24',
            summary: { byDay: [{ date: '2026-08-24', occupiedCount: 1, totalUnits: 2, occupancyRate: 0.5 }] },
            rows: [{ date: '2026-08-24', unitId: 'unit_1', unitCode: 'R01', unitName: 'Room 1', status: 'OCCUPIED' }],
          },
        });
      }
      if (url.includes('/reports/occupancy/export')) return csvResponse('Date,Unit code\n2026-08-24,R01\n');
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Reports' })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Run report' }));
    await waitFor(() => expect(screen.getByText('Daily occupancy')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Export CSV' }));

    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/reports/occupancy/export'), expect.anything());
  });

  it('a DEPARTMENT-scoped report:view holder sees no Export CSV button and no department filter for occupancy', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: viewOnlyDeptUser });
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Reports' })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Export CSV' })).not.toBeInTheDocument();
  });
});
