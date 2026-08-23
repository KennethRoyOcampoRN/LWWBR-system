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
