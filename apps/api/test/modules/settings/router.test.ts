import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPrisma = {
  user: { findFirst: vi.fn() },
  fileObject: { findFirst: vi.fn() },
  setting: { findUnique: vi.fn(), upsert: vi.fn() },
};

vi.mock('../../../src/lib/prisma.js', () => ({ prisma: mockPrisma }));

const mockGetSignedUrl = vi.fn().mockResolvedValue('https://storage.example/signed/logo.png');
vi.mock('../../../src/adapters/storage/index.js', () => ({
  getStorageAdapter: () => ({ getSignedUrl: mockGetSignedUrl }),
}));

const { createApp } = await import('../../../src/app.js');
const { signAccessToken } = await import('../../../src/modules/auth/tokens.js');

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSignedUrl.mockResolvedValue('https://storage.example/signed/logo.png');
});

function userWithRole(roleKey: string) {
  return {
    id: 'user_1',
    employeeCode: 'LWW-001',
    fullName: 'System Admin (Demo)',
    email: null,
    department: 'MANAGEMENT',
    isActive: true,
    mustChangePassword: false,
    deletedAt: null,
    roles: [{ role: { key: roleKey } }],
  };
}

function authCookie() {
  return [`lwwbr_access=${signAccessToken('user_1')}`];
}

const resortIdentityRow = {
  key: 'resort.identity',
  value: {
    name: 'Lucky Waku Waku Beach Resort',
    address: '225 Caisip Blvd, Phase 3, San Diego, Lian, Batangas',
    cellNo: '09668294198',
    contactNo: '043-726-7198',
    website: 'www.luckywakuwakubeachresort.com',
    facebookUrl: 'Lucky Waku Waku Beach Resort',
    logoFileId: 'file_logo_1',
  },
  updatedById: 'user_1',
  updatedAt: new Date(),
  createdAt: new Date(),
};

const logoFile = {
  id: 'file_logo_1',
  filename: 'logo.png',
  mimeType: 'image/png',
  sizeBytes: 1234,
  storageKey: 'uploads/logo.png',
  deletedAt: null,
};

describe('GET /api/v1/settings/resort-identity', () => {
  it('allows resort:configure to read the current resort identity, including a signed logo URL', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('SYSTEM_ADMIN'));
    mockPrisma.setting.findUnique.mockResolvedValue(resortIdentityRow);
    mockPrisma.fileObject.findFirst.mockResolvedValue(logoFile);

    const res = await request(createApp()).get('/api/v1/settings/resort-identity').set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.resortIdentity).toMatchObject({
      name: 'Lucky Waku Waku Beach Resort',
      address: '225 Caisip Blvd, Phase 3, San Diego, Lian, Batangas',
      cellNo: '09668294198',
      contactNo: '043-726-7198',
    });
    expect(res.body.resortIdentity.logo).toEqual({
      id: 'file_logo_1',
      filename: 'logo.png',
      mimeType: 'image/png',
      url: 'https://storage.example/signed/logo.png',
    });
  });

  // Real gap this covers: workOrder.photoRequirements's own established
  // pattern falls back to a default when the Setting row doesn't exist
  // yet (never seeded) — the resort-identity read must do the same
  // rather than 500 on a brand-new install that hasn't saved anything.
  it('returns an empty-but-valid default when no Setting row exists yet', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('SYSTEM_ADMIN'));
    mockPrisma.setting.findUnique.mockResolvedValue(null);

    const res = await request(createApp()).get('/api/v1/settings/resort-identity').set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.resortIdentity).toMatchObject({ name: '', address: '', logo: null });
  });

  it.each(['CASHIER', 'ADMIN_HEAD', 'OWNER'])(
    'refuses %s — resort identity is resort:configure only (System Admin / Resort Manager)',
    async (roleKey) => {
      mockPrisma.user.findFirst.mockResolvedValue(userWithRole(roleKey));
      const res = await request(createApp()).get('/api/v1/settings/resort-identity').set('Cookie', authCookie());
      expect(res.status).toBe(403);
    },
  );

  it('allows RESORT_MANAGER — the client-named second role for this setting', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.setting.findUnique.mockResolvedValue(null);

    const res = await request(createApp()).get('/api/v1/settings/resort-identity').set('Cookie', authCookie());
    expect(res.status).toBe(200);
  });
});

describe('PATCH /api/v1/settings/resort-identity', () => {
  it('allows resort:configure to save the resort identity', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('SYSTEM_ADMIN'));
    mockPrisma.setting.upsert.mockResolvedValue(resortIdentityRow);
    mockPrisma.setting.findUnique.mockResolvedValue(resortIdentityRow);
    mockPrisma.fileObject.findFirst.mockResolvedValue(logoFile);

    const res = await request(createApp())
      .patch('/api/v1/settings/resort-identity')
      .set('Cookie', authCookie())
      .send({
        name: 'Lucky Waku Waku Beach Resort',
        address: '225 Caisip Blvd, Phase 3, San Diego, Lian, Batangas',
        cellNo: '09668294198',
        contactNo: '043-726-7198',
        website: 'www.luckywakuwakubeachresort.com',
        facebookUrl: 'Lucky Waku Waku Beach Resort',
        logoFileId: 'file_logo_1',
      });

    expect(res.status).toBe(200);
    expect(mockPrisma.setting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: 'resort.identity' },
        update: expect.objectContaining({
          value: expect.objectContaining({ name: 'Lucky Waku Waku Beach Resort' }),
          updatedById: 'user_1',
        }),
      }),
    );
    expect(res.body.resortIdentity.name).toBe('Lucky Waku Waku Beach Resort');
  });

  it('rejects a blank name or address', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('SYSTEM_ADMIN'));

    const res = await request(createApp())
      .patch('/api/v1/settings/resort-identity')
      .set('Cookie', authCookie())
      .send({ name: '', address: '' });

    expect(res.status).toBe(422);
    expect(mockPrisma.setting.upsert).not.toHaveBeenCalled();
  });

  // Real gap this covers: a stale or mistyped logoFileId (the client
  // uploads via the existing generic POST /files, then PATCHes the
  // resulting id in here — nothing stops that id from referencing a
  // file that was later deleted or never existed) must not silently
  // save an unreachable reference onto a setting every future Receipt
  // snapshots its logo from.
  it('rejects a logoFileId that does not reference a real, non-deleted file', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('SYSTEM_ADMIN'));
    mockPrisma.fileObject.findFirst.mockResolvedValue(null);

    const res = await request(createApp())
      .patch('/api/v1/settings/resort-identity')
      .set('Cookie', authCookie())
      .send({ name: 'Lucky Waku Waku Beach Resort', address: 'Batangas', logoFileId: 'file_missing' });

    expect(res.status).toBe(422);
    expect(mockPrisma.setting.upsert).not.toHaveBeenCalled();
  });

  it('allows clearing the logo by passing logoFileId: null', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.setting.upsert.mockResolvedValue({
      ...resortIdentityRow,
      value: { ...resortIdentityRow.value, logoFileId: null },
    });
    mockPrisma.setting.findUnique.mockResolvedValue({
      ...resortIdentityRow,
      value: { ...resortIdentityRow.value, logoFileId: null },
    });

    const res = await request(createApp())
      .patch('/api/v1/settings/resort-identity')
      .set('Cookie', authCookie())
      .send({ name: 'Lucky Waku Waku Beach Resort', address: 'Batangas', logoFileId: null });

    expect(res.status).toBe(200);
    expect(res.body.resortIdentity.logo).toBeNull();
    expect(mockPrisma.fileObject.findFirst).not.toHaveBeenCalled();
  });

  it.each(['CASHIER', 'ADMIN_HEAD', 'OWNER'])('refuses %s from saving the resort identity', async (roleKey) => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole(roleKey));

    const res = await request(createApp())
      .patch('/api/v1/settings/resort-identity')
      .set('Cookie', authCookie())
      .send({ name: 'Lucky Waku Waku Beach Resort', address: 'Batangas' });

    expect(res.status).toBe(403);
    expect(mockPrisma.setting.upsert).not.toHaveBeenCalled();
  });
});
