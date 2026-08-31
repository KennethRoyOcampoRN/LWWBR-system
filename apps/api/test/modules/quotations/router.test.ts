import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPrisma = {
  user: { findFirst: vi.fn(), findMany: vi.fn() },
  referenceSequence: { upsert: vi.fn() },
  quotationRequest: { create: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  auditLog: { create: vi.fn(), count: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
};

vi.mock('../../../src/lib/prisma.js', () => ({ prisma: mockPrisma }));

const { createApp } = await import('../../../src/app.js');
const { signAccessToken } = await import('../../../src/modules/auth/tokens.js');

function userWithRole(roleKey: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'user_1',
    employeeCode: 'LWW-020',
    fullName: 'Admin Staff (Demo)',
    email: null,
    department: 'FRONT_OFFICE',
    isActive: true,
    mustChangePassword: false,
    deletedAt: null,
    roles: [{ role: { key: roleKey } }],
    ...overrides,
  };
}

function authCookie() {
  return [`lwwbr_access=${signAccessToken('user_1')}`];
}

function fakeQuotationRequest(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'quote_1',
    referenceNo: 'QT-260831-0001',
    name: 'Maria Santos',
    contactNumber: '+639171234567',
    email: 'maria@example.com',
    pax: 4,
    checkInDate: new Date('2026-09-15T00:00:00.000Z'),
    checkOutDate: new Date('2026-09-17T00:00:00.000Z'),
    note: null,
    status: 'PENDING',
    createdById: 'user_1',
    updatedById: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.auditLog.findFirst.mockResolvedValue(null);
  mockPrisma.auditLog.count.mockResolvedValue(0);
  mockPrisma.auditLog.findMany.mockResolvedValue([]);
  mockPrisma.referenceSequence.upsert.mockResolvedValue({ scope: 'QT-260831', seq: 1 });
});

const CREATE_BODY = {
  name: 'Maria Santos',
  contactNumber: '+639171234567',
  email: 'maria@example.com',
  pax: 4,
  checkInDate: '2026-09-15T00:00:00.000Z',
  checkOutDate: '2026-09-17T00:00:00.000Z',
};

describe('POST /api/v1/quotation-requests', () => {
  it.each(['RESORT_MANAGER', 'ADMIN_HEAD', 'ADMIN_STAFF'])('allows %s to create a quotation request', async (roleKey) => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole(roleKey));
    mockPrisma.quotationRequest.create.mockResolvedValue(fakeQuotationRequest());

    const res = await request(createApp()).post('/api/v1/quotation-requests').set('Cookie', authCookie()).send(CREATE_BODY);

    expect(res.status).toBe(201);
    expect(res.body.quotationRequest.referenceNo).toBe('QT-260831-0001');
  });

  // The one explicitly named exclusion in the client's own spec:
  // SYSTEM_ADMIN can see and resolve every quotation but never creates
  // one. Easiest asymmetry in this feature to regress silently, so it
  // gets its own dedicated test rather than folding into a generic loop.
  it('refuses SYSTEM_ADMIN — explicitly excluded from quotation:create', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('SYSTEM_ADMIN'));
    const res = await request(createApp()).post('/api/v1/quotation-requests').set('Cookie', authCookie()).send(CREATE_BODY);
    expect(res.status).toBe(403);
    expect(mockPrisma.quotationRequest.create).not.toHaveBeenCalled();
  });

  it('refuses OWNER — read-only on quotations', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('OWNER'));
    const res = await request(createApp()).post('/api/v1/quotation-requests').set('Cookie', authCookie()).send(CREATE_BODY);
    expect(res.status).toBe(403);
  });

  it('refuses a role with no quotation:* access at all', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_STAFF'));
    const res = await request(createApp()).post('/api/v1/quotation-requests').set('Cookie', authCookie()).send(CREATE_BODY);
    expect(res.status).toBe(403);
  });
});

describe('GET /api/v1/quotation-requests', () => {
  it.each(['SYSTEM_ADMIN', 'OWNER', 'RESORT_MANAGER', 'ADMIN_HEAD', 'ADMIN_STAFF'])(
    'allows %s to view the list',
    async (roleKey) => {
      mockPrisma.user.findFirst.mockResolvedValue(userWithRole(roleKey));
      mockPrisma.quotationRequest.findMany.mockResolvedValue([fakeQuotationRequest()]);

      const res = await request(createApp()).get('/api/v1/quotation-requests').set('Cookie', authCookie());
      expect(res.status).toBe(200);
      expect(res.body.quotationRequests).toHaveLength(1);
    },
  );

  it('refuses a role with no quotation:* access at all', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_STAFF'));
    const res = await request(createApp()).get('/api/v1/quotation-requests').set('Cookie', authCookie());
    expect(res.status).toBe(403);
  });
});

describe('POST /api/v1/quotation-requests/:id/status', () => {
  it('lets SYSTEM_ADMIN mark a quotation DONE', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('SYSTEM_ADMIN'));
    mockPrisma.quotationRequest.findFirst.mockResolvedValue(fakeQuotationRequest());
    mockPrisma.quotationRequest.update.mockResolvedValue(fakeQuotationRequest({ status: 'DONE', updatedById: 'user_1' }));

    const res = await request(createApp())
      .post('/api/v1/quotation-requests/quote_1/status')
      .set('Cookie', authCookie())
      .send({ toStatus: 'DONE' });

    expect(res.status).toBe(200);
    expect(res.body.quotationRequest.status).toBe('DONE');
  });

  it('lets SYSTEM_ADMIN revert a DONE quotation back to PENDING', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('SYSTEM_ADMIN'));
    mockPrisma.quotationRequest.findFirst.mockResolvedValue(fakeQuotationRequest({ status: 'DONE' }));
    mockPrisma.quotationRequest.update.mockResolvedValue(fakeQuotationRequest({ status: 'PENDING' }));

    const res = await request(createApp())
      .post('/api/v1/quotation-requests/quote_1/status')
      .set('Cookie', authCookie())
      .send({ toStatus: 'PENDING' });

    expect(res.status).toBe(200);
    expect(res.body.quotationRequest.status).toBe('PENDING');
  });

  // Creator roles (and OWNER) can create/read but not resolve — only
  // SYSTEM_ADMIN holds quotation:update_status.
  it.each(['RESORT_MANAGER', 'ADMIN_HEAD', 'ADMIN_STAFF', 'OWNER'])('refuses %s — quotation:update_status is SYSTEM_ADMIN-only', async (roleKey) => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole(roleKey));
    const res = await request(createApp())
      .post('/api/v1/quotation-requests/quote_1/status')
      .set('Cookie', authCookie())
      .send({ toStatus: 'DONE' });
    expect(res.status).toBe(403);
    expect(mockPrisma.quotationRequest.update).not.toHaveBeenCalled();
  });

  it('404s for a quotation that does not exist', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('SYSTEM_ADMIN'));
    mockPrisma.quotationRequest.findFirst.mockResolvedValue(null);

    const res = await request(createApp())
      .post('/api/v1/quotation-requests/missing/status')
      .set('Cookie', authCookie())
      .send({ toStatus: 'DONE' });

    expect(res.status).toBe(404);
  });
});
