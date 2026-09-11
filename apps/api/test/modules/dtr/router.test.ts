import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPrisma = {
  user: { findFirst: vi.fn() },
  fileObject: { findFirst: vi.fn() },
  setting: { findUnique: vi.fn(), upsert: vi.fn() },
  timeLog: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
  auditLog: { create: vi.fn(), count: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
};

vi.mock('../../../src/lib/prisma.js', () => ({ prisma: mockPrisma }));

const mockGetSignedUrl = vi.fn().mockResolvedValue('https://storage.example/signed/selfie.jpg');
vi.mock('../../../src/adapters/storage/index.js', () => ({
  getStorageAdapter: () => ({ getSignedUrl: mockGetSignedUrl }),
}));

const { createApp } = await import('../../../src/app.js');
const { signAccessToken } = await import('../../../src/modules/auth/tokens.js');

function userWithRole(roleKey: string) {
  return {
    id: 'user_1',
    employeeCode: 'LWW-011',
    fullName: 'Housekeeping Staff (Demo)',
    email: null,
    department: 'HOUSEKEEPING',
    isActive: true,
    mustChangePassword: false,
    deletedAt: null,
    roles: [{ role: { key: roleKey } }],
  };
}

function authCookie() {
  return [`lwwbr_access=${signAccessToken('user_1')}`];
}

const GEOFENCE = { centerLat: 13.75, centerLng: 121.05, radiusMeters: 200 };

function fakeTimeLog(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'timelog_1',
    userId: 'user_1',
    clockInAt: new Date('2026-09-20T06:00:00.000Z'),
    clockOutAt: null,
    source: 'WEB',
    note: null,
    clockInPhotoId: 'file_1',
    clockOutPhotoId: null,
    clockInLat: 13.75,
    clockInLng: 121.05,
    clockOutLat: null,
    clockOutLng: null,
    clockInFlagged: false,
    clockOutFlagged: false,
    reviewedById: null,
    reviewedAt: null,
    reviewNote: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    user: { id: 'user_1', fullName: 'Housekeeping Staff (Demo)' },
    clockInPhoto: { id: 'file_1', filename: 'selfie.jpg', mimeType: 'image/jpeg', storageKey: 'uploads/selfie.jpg' },
    clockOutPhoto: null,
    reviewedBy: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.auditLog.findFirst.mockResolvedValue(null);
  mockPrisma.auditLog.count.mockResolvedValue(0);
  mockPrisma.auditLog.findMany.mockResolvedValue([]);
  mockGetSignedUrl.mockResolvedValue('https://storage.example/signed/selfie.jpg');
});

describe('POST /api/v1/time-logs/clock-in', () => {
  it('clocks in successfully with a photo and a location inside the configured geofence — not flagged', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('HOUSEKEEPING_STAFF'));
    mockPrisma.fileObject.findFirst.mockResolvedValue({ id: 'file_1' });
    mockPrisma.timeLog.findFirst.mockResolvedValue(null);
    mockPrisma.setting.findUnique.mockResolvedValue({ key: 'dtr.geofence', value: GEOFENCE });
    mockPrisma.timeLog.create.mockResolvedValue(fakeTimeLog());

    const res = await request(createApp())
      .post('/api/v1/time-logs/clock-in')
      .set('Cookie', authCookie())
      .send({ photoFileId: 'file_1', lat: 13.7501, lng: 121.0501 });

    expect(res.status).toBe(201);
    expect(mockPrisma.timeLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ clockInFlagged: false }) }),
    );
    expect(res.body.timeLog.clockInPhoto).toEqual({
      id: 'file_1',
      filename: 'selfie.jpg',
      mimeType: 'image/jpeg',
      url: 'https://storage.example/signed/selfie.jpg',
    });
    expect(res.body.timeLog.clockInPhoto.storageKey).toBeUndefined();
  });

  it('clocks in successfully with a location outside the configured geofence — flagged, not blocked', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('HOUSEKEEPING_STAFF'));
    mockPrisma.fileObject.findFirst.mockResolvedValue({ id: 'file_1' });
    mockPrisma.timeLog.findFirst.mockResolvedValue(null);
    mockPrisma.setting.findUnique.mockResolvedValue({ key: 'dtr.geofence', value: GEOFENCE });
    mockPrisma.timeLog.create.mockResolvedValue(fakeTimeLog({ clockInFlagged: true }));

    const res = await request(createApp())
      .post('/api/v1/time-logs/clock-in')
      .set('Cookie', authCookie())
      .send({ photoFileId: 'file_1', lat: 14.5, lng: 121.05 });

    expect(res.status).toBe(201);
    expect(mockPrisma.timeLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ clockInFlagged: true }) }),
    );
  });

  it('clocks in successfully with no location at all (denied/failed geolocation) — flagged when a geofence is configured', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('HOUSEKEEPING_STAFF'));
    mockPrisma.fileObject.findFirst.mockResolvedValue({ id: 'file_1' });
    mockPrisma.timeLog.findFirst.mockResolvedValue(null);
    mockPrisma.setting.findUnique.mockResolvedValue({ key: 'dtr.geofence', value: GEOFENCE });
    mockPrisma.timeLog.create.mockResolvedValue(fakeTimeLog({ clockInFlagged: true, clockInLat: null, clockInLng: null }));

    const res = await request(createApp())
      .post('/api/v1/time-logs/clock-in')
      .set('Cookie', authCookie())
      .send({ photoFileId: 'file_1' });

    expect(res.status).toBe(201);
    expect(mockPrisma.timeLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ clockInFlagged: true }) }),
    );
  });

  it('never flags for location reasons when no geofence is configured at all', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('HOUSEKEEPING_STAFF'));
    mockPrisma.fileObject.findFirst.mockResolvedValue({ id: 'file_1' });
    mockPrisma.timeLog.findFirst.mockResolvedValue(null);
    mockPrisma.setting.findUnique.mockResolvedValue(null);
    mockPrisma.timeLog.create.mockResolvedValue(fakeTimeLog());

    const res = await request(createApp())
      .post('/api/v1/time-logs/clock-in')
      .set('Cookie', authCookie())
      .send({ photoFileId: 'file_1' });

    expect(res.status).toBe(201);
    expect(mockPrisma.timeLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ clockInFlagged: false }) }),
    );
  });

  it('rejects a clock-in with no photo (hard requirement)', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('HOUSEKEEPING_STAFF'));
    const res = await request(createApp())
      .post('/api/v1/time-logs/clock-in')
      .set('Cookie', authCookie())
      .send({ lat: 13.75, lng: 121.05 });
    expect(res.status).toBe(422);
    expect(mockPrisma.timeLog.create).not.toHaveBeenCalled();
  });

  it('rejects a photoFileId that does not resolve to a real file', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('HOUSEKEEPING_STAFF'));
    mockPrisma.fileObject.findFirst.mockResolvedValue(null);
    const res = await request(createApp())
      .post('/api/v1/time-logs/clock-in')
      .set('Cookie', authCookie())
      .send({ photoFileId: 'file_missing' });
    expect(res.status).toBe(422);
    expect(mockPrisma.timeLog.create).not.toHaveBeenCalled();
  });

  it('rejects a second clock-in while one is already open', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('HOUSEKEEPING_STAFF'));
    mockPrisma.fileObject.findFirst.mockResolvedValue({ id: 'file_1' });
    mockPrisma.timeLog.findFirst.mockResolvedValue(fakeTimeLog());

    const res = await request(createApp())
      .post('/api/v1/time-logs/clock-in')
      .set('Cookie', authCookie())
      .send({ photoFileId: 'file_1' });

    expect(res.status).toBe(409);
    expect(mockPrisma.timeLog.create).not.toHaveBeenCalled();
  });

  it.each(['SYSTEM_ADMIN', 'OWNER', 'HOUSEKEEPING_STAFF', 'RESTAURANT_STAFF'])(
    'allows %s to clock in — no shift:* permission required, identity only',
    async (roleKey) => {
      mockPrisma.user.findFirst.mockResolvedValue(userWithRole(roleKey));
      mockPrisma.fileObject.findFirst.mockResolvedValue({ id: 'file_1' });
      mockPrisma.timeLog.findFirst.mockResolvedValue(null);
      mockPrisma.setting.findUnique.mockResolvedValue(null);
      mockPrisma.timeLog.create.mockResolvedValue(fakeTimeLog());

      const res = await request(createApp())
        .post('/api/v1/time-logs/clock-in')
        .set('Cookie', authCookie())
        .send({ photoFileId: 'file_1' });

      expect(res.status).toBe(201);
    },
  );
});

describe('POST /api/v1/time-logs/clock-out', () => {
  it('clocks out successfully, closing the open entry', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('HOUSEKEEPING_STAFF'));
    mockPrisma.fileObject.findFirst.mockResolvedValue({ id: 'file_2' });
    mockPrisma.timeLog.findFirst.mockResolvedValue(fakeTimeLog());
    mockPrisma.setting.findUnique.mockResolvedValue({ key: 'dtr.geofence', value: GEOFENCE });
    mockPrisma.timeLog.update.mockResolvedValue(
      fakeTimeLog({ clockOutAt: new Date(), clockOutPhotoId: 'file_2', clockOutFlagged: false }),
    );

    const res = await request(createApp())
      .post('/api/v1/time-logs/clock-out')
      .set('Cookie', authCookie())
      .send({ photoFileId: 'file_2', lat: 13.7501, lng: 121.0501 });

    expect(res.status).toBe(200);
    expect(mockPrisma.timeLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'timelog_1' },
        data: expect.objectContaining({ clockOutPhotoId: 'file_2', clockOutFlagged: false }),
      }),
    );
  });

  it('rejects a clock-out with no open entry', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('HOUSEKEEPING_STAFF'));
    mockPrisma.fileObject.findFirst.mockResolvedValue({ id: 'file_2' });
    mockPrisma.timeLog.findFirst.mockResolvedValue(null);

    const res = await request(createApp())
      .post('/api/v1/time-logs/clock-out')
      .set('Cookie', authCookie())
      .send({ photoFileId: 'file_2' });

    expect(res.status).toBe(409);
    expect(mockPrisma.timeLog.update).not.toHaveBeenCalled();
  });

  it('rejects a clock-out with no photo', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('HOUSEKEEPING_STAFF'));
    const res = await request(createApp()).post('/api/v1/time-logs/clock-out').set('Cookie', authCookie()).send({});
    expect(res.status).toBe(422);
  });
});

describe('GET /api/v1/time-logs', () => {
  it('a shift:manage holder sees everyone\'s entries by default', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.timeLog.findMany.mockResolvedValue([fakeTimeLog()]);

    await request(createApp()).get('/api/v1/time-logs').set('Cookie', authCookie());

    const call = mockPrisma.timeLog.findMany.mock.calls[0]![0];
    expect(call.where.userId).toBeUndefined();
  });

  it('a caller without shift:manage always sees only their own entries', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('HOUSEKEEPING_STAFF'));
    mockPrisma.timeLog.findMany.mockResolvedValue([fakeTimeLog()]);

    await request(createApp()).get('/api/v1/time-logs?userId=someone_else').set('Cookie', authCookie());

    expect(mockPrisma.timeLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: 'user_1' }) }),
    );
  });
});

describe('GET /api/v1/time-logs/flagged', () => {
  it('allows shift:manage to view the flagged queue', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.timeLog.findMany.mockResolvedValue([fakeTimeLog({ clockInFlagged: true })]);

    const res = await request(createApp()).get('/api/v1/time-logs/flagged').set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(mockPrisma.timeLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ reviewedAt: null }) }),
    );
  });

  it('refuses a shift:read-only holder', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('HOUSEKEEPING_STAFF'));
    const res = await request(createApp()).get('/api/v1/time-logs/flagged').set('Cookie', authCookie());
    expect(res.status).toBe(403);
  });
});

describe('POST /api/v1/time-logs/:id/review', () => {
  it('lets shift:manage review a flagged entry', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.timeLog.findFirst.mockResolvedValue(fakeTimeLog({ clockInFlagged: true }));
    mockPrisma.timeLog.update.mockResolvedValue(
      fakeTimeLog({ clockInFlagged: true, reviewedById: 'user_1', reviewedAt: new Date() }),
    );

    const res = await request(createApp())
      .post('/api/v1/time-logs/timelog_1/review')
      .set('Cookie', authCookie())
      .send({ reviewNote: 'Confirmed with employee, was doing a supply run.' });

    expect(res.status).toBe(200);
    expect(mockPrisma.timeLog.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ reviewedById: 'user_1' }) }),
    );
  });

  it('rejects reviewing an entry that was never flagged', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.timeLog.findFirst.mockResolvedValue(fakeTimeLog({ clockInFlagged: false, clockOutFlagged: false }));

    const res = await request(createApp())
      .post('/api/v1/time-logs/timelog_1/review')
      .set('Cookie', authCookie())
      .send({});

    expect(res.status).toBe(409);
    expect(mockPrisma.timeLog.update).not.toHaveBeenCalled();
  });

  it('404s for an entry that does not exist', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.timeLog.findFirst.mockResolvedValue(null);
    const res = await request(createApp()).post('/api/v1/time-logs/missing/review').set('Cookie', authCookie()).send({});
    expect(res.status).toBe(404);
  });

  it('refuses a shift:read-only holder', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('HOUSEKEEPING_STAFF'));
    const res = await request(createApp()).post('/api/v1/time-logs/timelog_1/review').set('Cookie', authCookie()).send({});
    expect(res.status).toBe(403);
  });
});

describe('GET/PUT /api/v1/dtr/geofence-setting', () => {
  it('allows system:configure to read the geofence setting', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('SYSTEM_ADMIN'));
    mockPrisma.setting.findUnique.mockResolvedValue({ key: 'dtr.geofence', value: GEOFENCE });

    const res = await request(createApp()).get('/api/v1/dtr/geofence-setting').set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.geofence).toEqual(GEOFENCE);
  });

  it('allows system:configure to set the geofence setting', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('SYSTEM_ADMIN'));
    mockPrisma.setting.upsert.mockResolvedValue({ key: 'dtr.geofence', value: GEOFENCE });

    const res = await request(createApp())
      .put('/api/v1/dtr/geofence-setting')
      .set('Cookie', authCookie())
      .send(GEOFENCE);

    expect(res.status).toBe(200);
    expect(mockPrisma.setting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { key: 'dtr.geofence' } }),
    );
  });

  it.each(['RESORT_MANAGER', 'HOUSEKEEPING_STAFF', 'OWNER'])(
    'refuses %s — geofence config is system:configure only',
    async (roleKey) => {
      mockPrisma.user.findFirst.mockResolvedValue(userWithRole(roleKey));
      const res = await request(createApp()).get('/api/v1/dtr/geofence-setting').set('Cookie', authCookie());
      expect(res.status).toBe(403);
    },
  );
});
