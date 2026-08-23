import { render, screen, waitFor, within } from '@testing-library/react';
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

const currentUser = {
  id: 'user_1',
  employeeCode: 'LWW-011',
  fullName: 'POC Maintenance (Demo)',
  email: null,
  department: 'MAINTENANCE',
  mustChangePassword: false,
  roles: ['POC_MAINTENANCE'],
  permissions: {
    'workorder:read': 'ALL',
    'workorder:create': 'ALL',
    'workorder:read_all': 'DEPARTMENT',
    'unit:read': 'ALL',
  },
};

describe('WorkOrdersPage', () => {
  beforeEach(() => {
    window.history.pushState({}, '', '/');
  });

  it('the mandatory photo gate: creating a MAINTENANCE ticket with no photo shows the real 422 PHOTO_REQUIRED error, then succeeds once one is attached', async () => {
    const user = userEvent.setup();
    let createAttempts = 0;
    let createdWorkOrders: unknown[] = [];

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: currentUser });
      if (url.endsWith('/units')) return jsonResponse(200, { units: [] });
      if (url.endsWith('/work-orders') && (!init || init.method === undefined)) {
        return jsonResponse(200, { workOrders: createdWorkOrders });
      }
      if (url.endsWith('/files') && init?.method === 'POST') {
        return jsonResponse(201, { file: { id: 'file_1', filename: 'issue.jpg', mimeType: 'image/jpeg', sizeBytes: 100 } });
      }
      if (url.endsWith('/work-orders') && init?.method === 'POST') {
        createAttempts += 1;
        const body = JSON.parse(init.body as string);
        if (createAttempts === 1) {
          return jsonResponse(422, {
            error: {
              code: 'PHOTO_REQUIRED',
              message: 'A photo is required.',
              details: { kind: 'ISSUE' },
            },
          });
        }
        const created = {
          id: 'wo_1',
          referenceNo: 'WO-260823-0001',
          type: body.type,
          title: body.title,
          priority: body.priority,
          status: 'OPEN',
          department: body.department,
          unit: null,
          assignedTo: null,
          createdAt: new Date().toISOString(),
        };
        createdWorkOrders = [created, ...createdWorkOrders];
        return jsonResponse(201, { workOrder: created });
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => expect(screen.getByRole('link', { name: 'Work Orders' })).toBeInTheDocument());
    await user.click(screen.getByRole('link', { name: 'Work Orders' }));
    await waitFor(() => expect(screen.getByText('New ticket')).toBeInTheDocument());

    await user.selectOptions(screen.getByLabelText('Type'), 'MAINTENANCE');
    expect(screen.getByText(/Required for Maintenance/i)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Title'), 'Leaking faucet in R01');

    // Submit with no photo attached — the request must actually fire and
    // come back with the server's real 422, not a client-side block.
    await user.click(screen.getByRole('button', { name: 'Create ticket' }));
    await waitFor(() => expect(createAttempts).toBe(1));
    expect(await screen.findByText(/An ISSUE photo is required/i)).toBeInTheDocument();
    expect(screen.getByText('No tickets yet.')).toBeInTheDocument();

    // Attach a photo, then submit again — now it should succeed.
    const file = new File([new Uint8Array([1, 2, 3])], 'issue.jpg', { type: 'image/jpeg' });
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(fileInput, file);
    await waitFor(() => expect(screen.getByText('issue.jpg')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Create ticket' }));
    await waitFor(() => expect(createAttempts).toBe(2));
    expect(await screen.findByText('Created WO-260823-0001.')).toBeInTheDocument();
    expect(screen.getByText('WO-260823-0001')).toBeInTheDocument();
    expect(screen.getByText('Leaking faucet in R01')).toBeInTheDocument();
    expect(screen.queryByText('No tickets yet.')).not.toBeInTheDocument();

    // Form reset after a successful create.
    expect(screen.getByLabelText('Title')).toHaveValue('');
    expect(screen.queryByText('issue.jpg')).not.toBeInTheDocument();
  });

  it('does not require a photo for HOUSEKEEPING — the default type — and creates directly', async () => {
    const user = userEvent.setup();
    let created: unknown = null;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: currentUser });
      if (url.endsWith('/units')) return jsonResponse(200, { units: [] });
      if (url.endsWith('/work-orders') && (!init || init.method === undefined)) {
        return jsonResponse(200, { workOrders: created ? [created] : [] });
      }
      if (url.endsWith('/work-orders') && init?.method === 'POST') {
        const body = JSON.parse(init.body as string);
        created = {
          id: 'wo_2',
          referenceNo: 'WO-260823-0002',
          type: body.type,
          title: body.title,
          priority: body.priority,
          status: 'OPEN',
          department: body.department,
          unit: null,
          assignedTo: null,
          createdAt: new Date().toISOString(),
        };
        return jsonResponse(201, { workOrder: created });
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => expect(screen.getByRole('link', { name: 'Work Orders' })).toBeInTheDocument());
    await user.click(screen.getByRole('link', { name: 'Work Orders' }));
    await waitFor(() => expect(screen.getByText('New ticket')).toBeInTheDocument());
    expect(screen.getByText(/optional for this type/i)).toBeInTheDocument();

    await user.type(screen.getByLabelText('Title'), 'Turn down service');
    await user.click(screen.getByRole('button', { name: 'Create ticket' }));

    expect(await screen.findByText('Created WO-260823-0002.')).toBeInTheDocument();
  });

  it('hides the New ticket form for a caller without workorder:create, but still shows the ticket list', async () => {
    const user = userEvent.setup();
    const readOnlyUser = { ...currentUser, permissions: { 'workorder:read': 'ALL' } };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: readOnlyUser });
      if (url.endsWith('/units')) return jsonResponse(200, { units: [] });
      if (url.endsWith('/work-orders')) return jsonResponse(200, { workOrders: [] });
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => expect(screen.getByRole('link', { name: 'Work Orders' })).toBeInTheDocument());
    await user.click(screen.getByRole('link', { name: 'Work Orders' }));
    await waitFor(() => expect(screen.getByText('Tickets')).toBeInTheDocument());
    expect(screen.queryByText('New ticket')).not.toBeInTheDocument();
  });
});

describe('WorkOrderDetailDrawer', () => {
  beforeEach(() => {
    window.history.pushState({}, '', '/');
  });

  function fakeListRow(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: 'wo_1',
      referenceNo: 'WO-260823-0001',
      type: 'MAINTENANCE',
      title: 'Leaking faucet in R01',
      priority: 'HIGH',
      status: 'ASSIGNED',
      department: 'MAINTENANCE',
      unit: { id: 'unit_1', code: 'R01', name: 'Room 1' },
      assignedTo: { fullName: 'Tech One' },
      createdAt: new Date().toISOString(),
      ...overrides,
    };
  }

  function fakeDetail(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      ...fakeListRow(),
      description: 'Faucet in the master bath keeps dripping.',
      version: 3,
      dueAt: null,
      attemptNo: 1,
      createdBy: { id: 'user_2', fullName: 'Front Desk (Demo)' },
      assignedTo: { id: 'user_1', fullName: 'Tech One' },
      photos: [
        {
          id: 'photo_1',
          kind: 'ISSUE',
          caption: null,
          capturedAt: new Date().toISOString(),
          attemptNo: 1,
          url: 'https://signed.example/issue.jpg',
        },
      ],
      notes: [],
      ...overrides,
    };
  }

  it('opens a ticket to show full description, photos, priority/department/assignee, and walks ASSIGNED -> IN_PROGRESS', async () => {
    const user = userEvent.setup();
    const listRow = fakeListRow();
    const detail = fakeDetail();
    let statusCalls = 0;
    const assignedTechUser = {
      ...currentUser,
      permissions: { ...currentUser.permissions, 'workorder:update_status': 'ALL' },
    };

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: assignedTechUser });
      if (url.endsWith('/units')) return jsonResponse(200, { units: [] });
      if (url.endsWith('/work-orders')) return jsonResponse(200, { workOrders: [listRow] });
      if (url.endsWith('/work-orders/wo_1') && (!init || init.method === undefined)) {
        return jsonResponse(200, { workOrder: detail });
      }
      if (url.endsWith('/work-orders/wo_1/status') && init?.method === 'POST') {
        statusCalls += 1;
        const body = JSON.parse(init.body as string);
        expect(body.toStatus).toBe('IN_PROGRESS');
        return jsonResponse(200, { workOrder: { ...detail, status: 'IN_PROGRESS', version: 4 } });
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => expect(screen.getByRole('link', { name: 'Work Orders' })).toBeInTheDocument());
    await user.click(screen.getByRole('link', { name: 'Work Orders' }));
    await waitFor(() => expect(screen.getByText('WO-260823-0001')).toBeInTheDocument());

    await user.click(screen.getByText('Leaking faucet in R01'));

    expect(await screen.findByText('Faucet in the master bath keeps dripping.')).toBeInTheDocument();
    expect(screen.getByAltText('Issue')).toHaveAttribute('src', 'https://signed.example/issue.jpg');
    expect(screen.getAllByText('Maintenance').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Tech One').length).toBeGreaterThan(0);

    const startButton = screen.getByRole('button', { name: 'Start' });
    await user.click(startButton);
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(statusCalls).toBe(1));
  });

  it('hides Verify/Reopen for a department POC verifying a different department\'s DONE ticket, per spec §7.2 — even though workorder:verify itself is held', async () => {
    const user = userEvent.setup();
    const crossDeptUser = {
      ...currentUser,
      permissions: { ...currentUser.permissions, 'workorder:verify': 'ALL' },
    };
    const listRow = fakeListRow({ status: 'DONE', department: 'HOUSEKEEPING' });
    const detail = fakeDetail({ status: 'DONE', department: 'HOUSEKEEPING', type: 'DEEP_CLEAN' });

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: crossDeptUser }); // MAINTENANCE dept, ticket is HOUSEKEEPING
      if (url.endsWith('/units')) return jsonResponse(200, { units: [] });
      if (url.endsWith('/work-orders')) return jsonResponse(200, { workOrders: [listRow] });
      if (url.endsWith('/work-orders/wo_1') && (!init || init.method === undefined)) {
        return jsonResponse(200, { workOrder: detail });
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => expect(screen.getByRole('link', { name: 'Work Orders' })).toBeInTheDocument());
    await user.click(screen.getByRole('link', { name: 'Work Orders' }));
    await waitFor(() => expect(screen.getByText('WO-260823-0001')).toBeInTheDocument());
    await user.click(screen.getByText('Leaking faucet in R01'));

    await screen.findByText('Faucet in the master bath keeps dripping.');
    // crossDeptUser holds workorder:verify itself (the resource
    // permission), but canVerifyWorkOrder's department-match rule still
    // hides the buttons since MAINTENANCE !== HOUSEKEEPING and none of
    // this user's roles are property-wide-exempt — proves the client-side
    // filter is the department check, not just the permission gate.
    expect(screen.queryByRole('button', { name: 'Verify' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Reopen/ })).not.toBeInTheDocument();
  });

  it('regression: an OPEN ticket shows exactly one assign entry point — "Assign ticket" with a real, property-wide assignee picker — never a bare "Mark Assigned" status button', async () => {
    const user = userEvent.setup();
    const assignerUser = {
      ...currentUser,
      permissions: { ...currentUser.permissions, 'workorder:assign': 'ALL' },
    };
    const listRow = fakeListRow({ status: 'OPEN', assignedTo: null });
    const detail = fakeDetail({ status: 'OPEN', assignedTo: null });
    let assignCallBody: unknown = null;

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: assignerUser });
      if (url.endsWith('/units')) return jsonResponse(200, { units: [] });
      if (url.endsWith('/work-orders')) return jsonResponse(200, { workOrders: [listRow] });
      if (url.endsWith('/work-orders/wo_1') && (!init || init.method === undefined)) {
        return jsonResponse(200, { workOrder: detail });
      }
      if (url.includes('/work-orders/assignable-users') && (!init || init.method === undefined)) {
        // Cross-department on purpose — proves the picker isn't scoped to
        // the ticket's own MAINTENANCE department.
        return jsonResponse(200, {
          users: [
            { id: 'user_9', fullName: 'Tech One', employeeCode: 'LWW-020', department: 'MAINTENANCE' },
            { id: 'user_10', fullName: 'Housekeeper One', employeeCode: 'LWW-021', department: 'HOUSEKEEPING' },
          ],
        });
      }
      if (url.endsWith('/work-orders/wo_1/assign') && init?.method === 'POST') {
        assignCallBody = JSON.parse(init.body as string);
        return jsonResponse(200, {
          workOrder: { ...detail, status: 'ASSIGNED', assignedTo: { id: 'user_9', fullName: 'Tech One' } },
        });
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => expect(screen.getByRole('link', { name: 'Work Orders' })).toBeInTheDocument());
    await user.click(screen.getByRole('link', { name: 'Work Orders' }));
    await waitFor(() => expect(screen.getByText('WO-260823-0001')).toBeInTheDocument());
    await user.click(screen.getByText('Leaking faucet in R01'));

    await screen.findByText('Faucet in the master bath keeps dripping.');

    // The bug: OPEN -> ASSIGNED is a real transition-table entry (so the
    // permission check stays correct), but without filtering it out of
    // the generic "Change status" list it surfaced as a second, broken
    // "Mark Assigned" button whose panel has no assignee field at all.
    expect(screen.queryByRole('button', { name: 'Mark Assigned' })).not.toBeInTheDocument();
    expect(screen.queryByText('Change status')).not.toBeInTheDocument();

    // The one real entry point: the dedicated Assign section.
    await user.click(screen.getByRole('button', { name: 'Assign ticket' }));
    await waitFor(() => expect(screen.getAllByRole('combobox').length).toBeGreaterThan(3)); // 3 in the New-ticket form + this picker
    const picker = screen.getAllByRole('combobox').at(-1) as HTMLSelectElement;
    // Property-wide, not department-scoped (client decision, 2026-08-23):
    // the ticket is MAINTENANCE, but a HOUSEKEEPING user still shows up.
    await waitFor(() => expect(within(picker).getAllByRole('option').length).toBeGreaterThan(1));
    within(picker).getByText(/Housekeeper One.*Housekeeping/);

    // The request itself carries no department filter at all.
    const assignableUsersCall = fetchMock.mock.calls.find(([reqInput]) =>
      (typeof reqInput === 'string' ? reqInput : reqInput.toString()).includes('/work-orders/assignable-users'),
    );
    expect(assignableUsersCall?.[0]?.toString()).not.toContain('department');

    await user.selectOptions(picker, 'user_9');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(assignCallBody).toEqual({ assignedToId: 'user_9', version: 3 }));
  });
});
