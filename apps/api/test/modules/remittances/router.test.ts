import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPrisma = {
  user: { findFirst: vi.fn(), findMany: vi.fn() },
  referenceSequence: { upsert: vi.fn() },
  fileObject: { findFirst: vi.fn() },
  remittanceRequest: { create: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  auditLog: { create: vi.fn(), count: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
};

vi.mock('../../../src/lib/prisma.js', () => ({ prisma: mockPrisma }));

const mockGetSignedUrl = vi.fn().mockResolvedValue('https://storage.example/signed/proof.jpg');
vi.mock('../../../src/adapters/storage/index.js', () => ({
  getStorageAdapter: () => ({ getSignedUrl: mockGetSignedUrl }),
}));

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

function fakeRemittanceRequest(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'remit_1',
    referenceNo: 'RM-260831-0001',
    name: 'Juan Dela Cruz',
    date: new Date('2026-08-30T00:00:00.000Z'),
    modeOfPayment: 'GCash',
    amount: '5000.00',
    referenceNumber: 'GC-123456789',
    proofFileId: null,
    proofFile: null,
    status: 'FOR_VERIFICATION',
    createdById: 'user_1',
    verifiedById: null,
    verifiedAt: null,
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
  mockPrisma.referenceSequence.upsert.mockResolvedValue({ scope: 'RM-260831', seq: 1 });
});

const CREATE_BODY = {
  name: 'Juan Dela Cruz',
  date: '2026-08-30T00:00:00.000Z',
  modeOfPayment: 'GCash',
  amount: 5000,
  referenceNumber: 'GC-123456789',
};

describe('POST /api/v1/remittance-requests', () => {
  // Client-approved role grants: Admin Head, Resort Manager, System
  // Admin, Admin Staff can create; every other role cannot.
  it.each(['SYSTEM_ADMIN', 'RESORT_MANAGER', 'ADMIN_HEAD', 'ADMIN_STAFF'])(
    'allows %s to create a remittance request',
    async (roleKey) => {
      mockPrisma.user.findFirst.mockResolvedValue(userWithRole(roleKey));
      mockPrisma.remittanceRequest.create.mockResolvedValue(fakeRemittanceRequest());

      const res = await request(createApp()).post('/api/v1/remittance-requests').set('Cookie', authCookie()).send(CREATE_BODY);

      expect(res.status).toBe(201);
      expect(res.body.remittanceRequest.referenceNo).toBe('RM-260831-0001');
      expect(res.body.remittanceRequest.amount).toBe(5000);
      expect(typeof res.body.remittanceRequest.amount).toBe('number');
    },
  );

  // OWNER verifies remittances but never creates one — same as the real
  // role shape (remittance:read + remittance:verify only).
  it('refuses OWNER — read/verify access does not include create', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('OWNER'));
    const res = await request(createApp()).post('/api/v1/remittance-requests').set('Cookie', authCookie()).send(CREATE_BODY);
    expect(res.status).toBe(403);
  });

  it('refuses a role with no remittance:* access at all (RESORT_STAFF)', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_STAFF'));
    const res = await request(createApp()).post('/api/v1/remittance-requests').set('Cookie', authCookie()).send(CREATE_BODY);
    expect(res.status).toBe(403);
  });

  // Real bug caught building this: the initial draft linked straight to
  // /api/v1/files/:id, which doesn't exist as a route (see files/
  // router.ts's own comment — reading a file back is scoped per-module,
  // never a generic route). Fixed to generate a real signed URL
  // server-side, same pattern as workorders/service.ts's getWorkOrder.
  // This test exercises that path end to end, not just the write.
  it('accepts an optional proofFileId once the referenced file is confirmed to exist, and returns a real signed URL for it', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
    mockPrisma.fileObject.findFirst.mockResolvedValue({ id: 'file_1' });
    mockPrisma.remittanceRequest.create.mockResolvedValue(
      fakeRemittanceRequest({
        proofFileId: 'file_1',
        proofFile: { id: 'file_1', filename: 'receipt.jpg', mimeType: 'image/jpeg', storageKey: 'uploads/receipt.jpg' },
      }),
    );

    const res = await request(createApp())
      .post('/api/v1/remittance-requests')
      .set('Cookie', authCookie())
      .send({ ...CREATE_BODY, proofFileId: 'file_1' });

    expect(res.status).toBe(201);
    expect(mockPrisma.remittanceRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ proofFileId: 'file_1' }) }),
    );
    expect(mockGetSignedUrl).toHaveBeenCalledWith('uploads/receipt.jpg');
    expect(res.body.remittanceRequest.proofFile).toEqual({
      id: 'file_1',
      filename: 'receipt.jpg',
      mimeType: 'image/jpeg',
      url: 'https://storage.example/signed/proof.jpg',
    });
    expect(res.body.remittanceRequest.proofFile.storageKey).toBeUndefined();
  });

  it('rejects a proofFileId that does not resolve to a real, non-deleted file', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
    mockPrisma.fileObject.findFirst.mockResolvedValue(null);

    const res = await request(createApp())
      .post('/api/v1/remittance-requests')
      .set('Cookie', authCookie())
      .send({ ...CREATE_BODY, proofFileId: 'file_missing' });

    expect(res.status).toBe(422);
    expect(mockPrisma.remittanceRequest.create).not.toHaveBeenCalled();
  });

  it('creates successfully with no proof photo at all — it is optional', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('ADMIN_STAFF'));
    mockPrisma.remittanceRequest.create.mockResolvedValue(fakeRemittanceRequest());

    const res = await request(createApp()).post('/api/v1/remittance-requests').set('Cookie', authCookie()).send(CREATE_BODY);

    expect(res.status).toBe(201);
    expect(mockPrisma.fileObject.findFirst).not.toHaveBeenCalled();
  });
});

describe('GET /api/v1/remittance-requests', () => {
  it.each(['SYSTEM_ADMIN', 'OWNER', 'RESORT_MANAGER', 'ADMIN_HEAD', 'ADMIN_STAFF'])(
    'allows %s to view the list',
    async (roleKey) => {
      mockPrisma.user.findFirst.mockResolvedValue(userWithRole(roleKey));
      mockPrisma.remittanceRequest.findMany.mockResolvedValue([fakeRemittanceRequest()]);

      const res = await request(createApp()).get('/api/v1/remittance-requests').set('Cookie', authCookie());
      expect(res.status).toBe(200);
      expect(res.body.remittanceRequests).toHaveLength(1);
    },
  );

  it('refuses a role with no remittance:* access at all', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_STAFF'));
    const res = await request(createApp()).get('/api/v1/remittance-requests').set('Cookie', authCookie());
    expect(res.status).toBe(403);
  });
});

describe('POST /api/v1/remittance-requests/:id/status', () => {
  it('lets OWNER mark a request VERIFIED', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('OWNER'));
    mockPrisma.remittanceRequest.findFirst.mockResolvedValue(fakeRemittanceRequest());
    mockPrisma.remittanceRequest.update.mockResolvedValue(
      fakeRemittanceRequest({ status: 'VERIFIED', verifiedById: 'user_1', verifiedAt: new Date() }),
    );

    const res = await request(createApp())
      .post('/api/v1/remittance-requests/remit_1/status')
      .set('Cookie', authCookie())
      .send({ toStatus: 'VERIFIED' });

    expect(res.status).toBe(200);
    expect(res.body.remittanceRequest.status).toBe('VERIFIED');
    expect(mockPrisma.remittanceRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'VERIFIED', verifiedById: 'user_1' }),
      }),
    );
  });

  // Not one-way — the client's own spec. OWNER can revert VERIFIED back
  // to FOR_VERIFICATION, and reverting clears the stale verifier.
  it('lets OWNER revert a VERIFIED request back to FOR_VERIFICATION, clearing verifiedBy', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('OWNER'));
    mockPrisma.remittanceRequest.findFirst.mockResolvedValue(
      fakeRemittanceRequest({ status: 'VERIFIED', verifiedById: 'user_1', verifiedAt: new Date() }),
    );
    mockPrisma.remittanceRequest.update.mockResolvedValue(fakeRemittanceRequest({ status: 'FOR_VERIFICATION' }));

    const res = await request(createApp())
      .post('/api/v1/remittance-requests/remit_1/status')
      .set('Cookie', authCookie())
      .send({ toStatus: 'FOR_VERIFICATION' });

    expect(res.status).toBe(200);
    expect(res.body.remittanceRequest.status).toBe('FOR_VERIFICATION');
    expect(mockPrisma.remittanceRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'FOR_VERIFICATION', verifiedById: null, verifiedAt: null }),
      }),
    );
  });

  // The creator role can create and read, but the status endpoint is
  // OWNER-only — a creator role attempting to verify their own
  // submission (or anyone else's) must be refused.
  it.each(['SYSTEM_ADMIN', 'RESORT_MANAGER', 'ADMIN_HEAD', 'ADMIN_STAFF'])(
    'refuses %s — remittance:verify is OWNER-only',
    async (roleKey) => {
      mockPrisma.user.findFirst.mockResolvedValue(userWithRole(roleKey));
      const res = await request(createApp())
        .post('/api/v1/remittance-requests/remit_1/status')
        .set('Cookie', authCookie())
        .send({ toStatus: 'VERIFIED' });
      expect(res.status).toBe(403);
      expect(mockPrisma.remittanceRequest.update).not.toHaveBeenCalled();
    },
  );

  it('404s for a request that does not exist', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('OWNER'));
    mockPrisma.remittanceRequest.findFirst.mockResolvedValue(null);

    const res = await request(createApp())
      .post('/api/v1/remittance-requests/missing/status')
      .set('Cookie', authCookie())
      .send({ toStatus: 'VERIFIED' });

    expect(res.status).toBe(404);
  });
});
