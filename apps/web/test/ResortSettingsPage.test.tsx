import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.js';

function jsonResponse(status: number, body: unknown) {
  return Promise.resolve({
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body),
  } as Response);
}

const systemAdminUser = {
  id: 'user_1',
  employeeCode: 'LWW-001',
  fullName: 'System Admin (Demo)',
  email: null,
  department: 'MANAGEMENT',
  mustChangePassword: false,
  roles: ['SYSTEM_ADMIN'],
  permissions: { 'resort:configure': 'ALL' },
};

const emptyIdentity = {
  name: '',
  address: '',
  cellNo: null,
  contactNo: null,
  website: null,
  facebookUrl: null,
  logo: null,
};

const savedIdentity = {
  name: 'Lucky Waku Waku Beach Resort',
  address: '225 Caisip Blvd, Phase 3, San Diego, Lian, Batangas',
  cellNo: '09668294198',
  contactNo: '043-726-7198',
  website: 'www.luckywakuwakubeachresort.com',
  facebookUrl: 'Lucky Waku Waku Beach Resort',
  logo: null,
};

describe('ResortSettingsPage', () => {
  it('a resort:configure holder can load and save the resort identity', async () => {
    const user = userEvent.setup();
    let saveBody: Record<string, unknown> | null = null;

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: systemAdminUser });
      if (url.endsWith('/settings/resort-identity') && (!init || init.method === undefined)) {
        return jsonResponse(200, { resortIdentity: saveBody ? savedIdentity : emptyIdentity });
      }
      if (url.endsWith('/settings/resort-identity') && init?.method === 'PATCH') {
        saveBody = JSON.parse(init.body as string);
        return jsonResponse(200, { resortIdentity: savedIdentity });
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState({}, '', '/resort-settings');

    render(<App />);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Resort Settings' })).toBeInTheDocument());
    await waitFor(() => expect(screen.getByLabelText('Resort name')).toHaveValue(''));

    await user.type(screen.getByLabelText('Resort name'), 'Lucky Waku Waku Beach Resort');
    await user.type(screen.getByLabelText('Address'), '225 Caisip Blvd, Phase 3, San Diego, Lian, Batangas');
    await user.type(screen.getByLabelText('Cell No.'), '09668294198');
    await user.type(screen.getByLabelText('Contact No.'), '043-726-7198');
    await user.type(screen.getByLabelText('Website'), 'www.luckywakuwakubeachresort.com');
    await user.type(screen.getByLabelText('Facebook'), 'Lucky Waku Waku Beach Resort');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(saveBody).toMatchObject({
      name: 'Lucky Waku Waku Beach Resort',
      address: '225 Caisip Blvd, Phase 3, San Diego, Lian, Batangas',
      cellNo: '09668294198',
      contactNo: '043-726-7198',
      logoFileId: null,
    }));
    await waitFor(() => expect(screen.getByText('Saved.')).toBeInTheDocument());
  });

  it('uploads a logo via the existing generic /files endpoint and includes its id when saving', async () => {
    const user = userEvent.setup();
    let saveBody: Record<string, unknown> | null = null;
    URL.createObjectURL = vi.fn().mockReturnValue('blob:mock-logo-url');

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: systemAdminUser });
      if (url.endsWith('/settings/resort-identity') && (!init || init.method === undefined)) {
        return jsonResponse(200, { resortIdentity: emptyIdentity });
      }
      if (url.endsWith('/files') && init?.method === 'POST') {
        return jsonResponse(201, { file: { id: 'file_logo_1', filename: 'logo.png', mimeType: 'image/png' } });
      }
      if (url.endsWith('/settings/resort-identity') && init?.method === 'PATCH') {
        saveBody = JSON.parse(init.body as string);
        return jsonResponse(200, { resortIdentity: { ...emptyIdentity, name: 'X', address: 'Y' } });
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState({}, '', '/resort-settings');

    render(<App />);

    await waitFor(() => expect(screen.getByLabelText('Resort name')).toBeInTheDocument());
    const file = new File(['x'], 'logo.png', { type: 'image/png' });
    await user.upload(screen.getByLabelText('Resort logo'), file);
    await waitFor(() => expect(screen.getByAltText('Resort logo')).toBeInTheDocument());

    await user.type(screen.getByLabelText('Resort name'), 'X');
    await user.type(screen.getByLabelText('Address'), 'Y');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(saveBody).toMatchObject({ logoFileId: 'file_logo_1' }));
  });

  it('a non-resort:configure holder does not see the Resort Settings nav item or page', async () => {
    const otherUser = { ...systemAdminUser, roles: ['CASHIER'], permissions: { 'unit:read': 'ALL' } };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/auth/me')) return jsonResponse(200, { user: otherUser });
      if (url.includes('/units/dashboard')) {
        return jsonResponse(200, {
          kpi: { occupied: 0, ready: 0, dirty: 0, outOfOrder: 0, urgentOpenWorkOrders: 0, checkinsToday: 0, checkoutsToday: 0, openFnbOrders: 0, lowStockItems: 0 },
          dirtyRooms: [], slaBreachedWorkOrders: [], overdueAmenityRequests: [], lowStockItems: [],
        });
      }
      if (url.includes('/units/activity')) return jsonResponse(200, { events: [] });
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState({}, '', '/');

    render(<App />);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Command Center' })).toBeInTheDocument());
    expect(screen.queryByRole('link', { name: 'Resort Settings' })).not.toBeInTheDocument();
  });
});
