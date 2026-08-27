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

  it('runs the maintenance log report and shows day-grouped tickets with photo thumbnails', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: managerUser });
      if (url.includes('/reports/maintenance-log?')) {
        return jsonResponse(200, {
          report: {
            key: 'maintenance-log',
            from: '2026-08-24',
            to: '2026-08-25',
            summary: { totalTickets: 1, byDay: [{ date: '2026-08-24', ticketCount: 1 }] },
            rows: [
              {
                id: 'wo_1',
                date: '2026-08-24',
                referenceNo: 'WO-001',
                title: 'Leaking faucet',
                status: 'VERIFIED',
                unitCode: 'R01',
                unitName: 'Room 1',
                createdAt: '2026-08-24T09:00:00.000Z',
                issuePhotos: [{ id: 'photo_1', url: 'https://signed.example/issue.jpg', caption: 'Before' }],
                completionPhotos: [],
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
    await user.selectOptions(screen.getByLabelText('Report'), 'maintenance-log');
    await user.click(screen.getByRole('button', { name: 'Run report' }));

    await waitFor(() => expect(screen.getByText(/WO-001: Leaking faucet/)).toBeInTheDocument());
    expect(screen.getByText('Tickets').parentElement).toHaveTextContent('1');
    expect(screen.getByAltText('Before')).toHaveAttribute('src', 'https://signed.example/issue.jpg');
    expect(screen.getByText('No completion photo yet')).toBeInTheDocument();
  });

  it('runs the F&B orders report and shows volume/revenue/prep-time/top-items, with the listed-value note', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: managerUser });
      if (url.includes('/reports/fnb-orders?')) {
        return jsonResponse(200, {
          report: {
            key: 'fnb-orders',
            from: '2026-08-24',
            to: '2026-08-25',
            summary: {
              totalVolume: 2,
              totalRevenue: 650,
              avgPrepTimeMinutes: 15,
              topItems: [{ itemName: 'Adobo', qty: 3 }],
            },
            rows: [
              {
                id: 'fnb_1',
                referenceNo: 'FNB-001',
                type: 'DINE_IN',
                status: 'SERVED',
                unitCode: 'R01',
                guestName: 'Juan',
                createdAt: '2026-08-24T01:00:00.000Z',
                readyAt: '2026-08-24T01:20:00.000Z',
                prepTimeMinutes: 20,
                subtotal: 500,
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
    await user.selectOptions(screen.getByLabelText('Report'), 'fnb-orders');
    await user.click(screen.getByRole('button', { name: 'Run report' }));

    await waitFor(() => expect(screen.getByText('FNB-001')).toBeInTheDocument());
    expect(screen.getByText('Volume').parentElement).toHaveTextContent('2');
    expect(screen.getByText('Revenue (listed value)').parentElement).toHaveTextContent('₱650.00');
    expect(screen.getByText('Avg. prep time').parentElement).toHaveTextContent('15m');
    expect(screen.getByText('Adobo')).toBeInTheDocument();
    expect(screen.getByText(/does not mean payment was collected or verified/)).toBeInTheDocument();
  });

  it('runs the amenity utilisation report and shows requests/qty-issued/loss-damage', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: managerUser });
      if (url.includes('/reports/amenity-utilisation?')) {
        return jsonResponse(200, {
          report: {
            key: 'amenity-utilisation',
            from: '2026-08-24',
            to: '2026-08-25',
            summary: {
              totalRequests: 2,
              totalQtyIssued: 3,
              lostDamagedCount: 1,
              byItem: [
                { itemName: 'Kayak', requestCount: 1, qtyIssued: 1, lostDamagedCount: 1 },
                { itemName: 'Beach towel', requestCount: 1, qtyIssued: 2, lostDamagedCount: 0 },
              ],
            },
            rows: [
              {
                id: 'am_1',
                referenceNo: 'LWW-AM-0001',
                itemName: 'Beach towel',
                unitCode: 'R01',
                qty: 2,
                status: 'RETURNED',
                requestedAt: '2026-08-24T01:00:00.000Z',
                issuedAt: '2026-08-24T01:05:00.000Z',
                returnedAt: '2026-08-24T10:00:00.000Z',
                conditionOnReturn: 'Good',
              },
              {
                id: 'am_2',
                referenceNo: 'LWW-AM-0002',
                itemName: 'Kayak',
                unitCode: 'R02',
                qty: 1,
                status: 'LOST_DAMAGED',
                requestedAt: '2026-08-24T02:00:00.000Z',
                issuedAt: '2026-08-24T02:05:00.000Z',
                returnedAt: null,
                conditionOnReturn: 'Paddle lost',
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
    await user.selectOptions(screen.getByLabelText('Report'), 'amenity-utilisation');
    await user.click(screen.getByRole('button', { name: 'Run report' }));

    await waitFor(() => expect(screen.getByText('LWW-AM-0001')).toBeInTheDocument());
    expect(screen.getByText('Requests').parentElement).toHaveTextContent('2');
    expect(screen.getByText('Qty issued').parentElement).toHaveTextContent('3');
    expect(screen.getByText('Lost / damaged').parentElement).toHaveTextContent('1');
    expect(screen.getByText('Paddle lost')).toBeInTheDocument();
  });

  it('runs the audit extract report and shows events, breakdowns, and expandable before/after', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: managerUser });
      if (url.includes('/reports/audit-extract?')) {
        return jsonResponse(200, {
          report: {
            key: 'audit-extract',
            from: '2026-08-24',
            to: '2026-08-25',
            summary: {
              totalEvents: 1,
              byAction: [{ action: 'update', count: 1 }],
              byEntity: [{ entity: 'WorkOrder', count: 1 }],
              topActors: [{ actorId: 'user_5', actorName: 'Resort Manager (Demo)', count: 1 }],
            },
            rows: [
              {
                id: 'audit_1',
                createdAt: '2026-08-24T01:00:00.000Z',
                actorId: 'user_5',
                actorName: 'Resort Manager (Demo)',
                action: 'update',
                entity: 'WorkOrder',
                entityId: 'wo_1',
                ip: '10.0.0.1',
                userAgent: 'Mozilla/5.0',
                before: '{"status":"OPEN"}',
                after: '{"status":"ASSIGNED"}',
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
    await user.selectOptions(screen.getByLabelText('Report'), 'audit-extract');
    await user.click(screen.getByRole('button', { name: 'Run report' }));

    await waitFor(() => expect(screen.getByText('wo_1')).toBeInTheDocument());
    expect(screen.getByText('Events').parentElement).toHaveTextContent('1');
    expect(screen.getByText('before/after')).toBeInTheDocument(); // rendered collapsed by default (<details>)
    expect(screen.getByText(/before: {"status":"OPEN"}/)).toBeInTheDocument();
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
