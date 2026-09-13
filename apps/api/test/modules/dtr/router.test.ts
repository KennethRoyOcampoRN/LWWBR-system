import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPrisma = {
  user: { findFirst: vi.fn() },
  fileObject: { findFirst: vi.fn() },
  geofence: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
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

// Two named fences, deliberately far apart — used throughout to prove
// "inside any one counts" rather than only ever testing a single fence.
const MAIN_RESORT = { id: 'geo_1', name: 'Main Resort', centerLat: 13.75, centerLng: 121.05, radiusMeters: 200 };
const SATELLITE_SITE = { id: 'geo_2', name: "Maria's Home", centerLat: 14.60, centerLng: 120.98, radiusMeters: 150 };

function fakeGeofence(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    ...MAIN_RESORT,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

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
    clockInFlagReason: null,
    clockOutFlagReason: null,
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
  it('clocks in successfully with a photo and a location inside a configured geofence — not flagged', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('HOUSEKEEPING_STAFF'));
    mockPrisma.fileObject.findFirst.mockResolvedValue({ id: 'file_1' });
    mockPrisma.timeLog.findFirst.mockResolvedValue(null);
    mockPrisma.geofence.findMany.mockResolvedValue([fakeGeofence()]);
    mockPrisma.timeLog.create.mockResolvedValue(fakeTimeLog());

    const res = await request(createApp())
      .post('/api/v1/time-logs/clock-in')
      .set('Cookie', authCookie())
      .send({ photoFileId: 'file_1', lat: 13.7501, lng: 121.0501 });

    expect(res.status).toBe(201);
    expect(mockPrisma.timeLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ clockInFlagged: false, clockInFlagReason: null }) }),
    );
    expect(res.body.timeLog.clockInPhoto).toEqual({
      id: 'file_1',
      filename: 'selfie.jpg',
      mimeType: 'image/jpeg',
      url: 'https://storage.example/signed/selfie.jpg',
    });
    expect(res.body.timeLog.clockInPhoto.storageKey).toBeUndefined();
  });

  // The multi-fence case the client specifically asked for: inside the
  // second configured fence, nowhere near the first — still not flagged.
  it('clocks in inside the second of two configured fences — "inside any one counts"', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('HOUSEKEEPING_STAFF'));
    mockPrisma.fileObject.findFirst.mockResolvedValue({ id: 'file_1' });
    mockPrisma.timeLog.findFirst.mockResolvedValue(null);
    mockPrisma.geofence.findMany.mockResolvedValue([fakeGeofence(), fakeGeofence(SATELLITE_SITE)]);
    mockPrisma.timeLog.create.mockResolvedValue(fakeTimeLog());

    const res = await request(createApp())
      .post('/api/v1/time-logs/clock-in')
      .set('Cookie', authCookie())
      .send({ photoFileId: 'file_1', lat: 14.6001, lng: 120.9801 });

    expect(res.status).toBe(201);
    expect(mockPrisma.timeLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ clockInFlagged: false, clockInFlagReason: null }) }),
    );
  });

  it('clocks in with a location outside every configured fence — flagged OUTSIDE_ALL_GEOFENCES, not blocked', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('HOUSEKEEPING_STAFF'));
    mockPrisma.fileObject.findFirst.mockResolvedValue({ id: 'file_1' });
    mockPrisma.timeLog.findFirst.mockResolvedValue(null);
    mockPrisma.geofence.findMany.mockResolvedValue([fakeGeofence(), fakeGeofence(SATELLITE_SITE)]);
    mockPrisma.timeLog.create.mockResolvedValue(fakeTimeLog({ clockInFlagged: true, clockInFlagReason: 'OUTSIDE_ALL_GEOFENCES' }));

    const res = await request(createApp())
      .post('/api/v1/time-logs/clock-in')
      .set('Cookie', authCookie())
      .send({ photoFileId: 'file_1', lat: 0, lng: 0 });

    expect(res.status).toBe(201);
    expect(mockPrisma.timeLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ clockInFlagged: true, clockInFlagReason: 'OUTSIDE_ALL_GEOFENCES' }),
      }),
    );
  });

  it('clocks in with no location at all (denied/failed geolocation) — flagged NO_LOCATION when a fence is configured', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('HOUSEKEEPING_STAFF'));
    mockPrisma.fileObject.findFirst.mockResolvedValue({ id: 'file_1' });
    mockPrisma.timeLog.findFirst.mockResolvedValue(null);
    mockPrisma.geofence.findMany.mockResolvedValue([fakeGeofence()]);
    mockPrisma.timeLog.create.mockResolvedValue(
      fakeTimeLog({ clockInFlagged: true, clockInFlagReason: 'NO_LOCATION', clockInLat: null, clockInLng: null }),
    );

    const res = await request(createApp())
      .post('/api/v1/time-logs/clock-in')
      .set('Cookie', authCookie())
      .send({ photoFileId: 'file_1' });

    expect(res.status).toBe(201);
    expect(mockPrisma.timeLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ clockInFlagged: true, clockInFlagReason: 'NO_LOCATION' }),
      }),
    );
  });

  it('never flags for location reasons when the geofence list is empty', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('HOUSEKEEPING_STAFF'));
    mockPrisma.fileObject.findFirst.mockResolvedValue({ id: 'file_1' });
    mockPrisma.timeLog.findFirst.mockResolvedValue(null);
    mockPrisma.geofence.findMany.mockResolvedValue([]);
    mockPrisma.timeLog.create.mockResolvedValue(fakeTimeLog());

    const res = await request(createApp())
      .post('/api/v1/time-logs/clock-in')
      .set('Cookie', authCookie())
      .send({ photoFileId: 'file_1' });

    expect(res.status).toBe(201);
    expect(mockPrisma.timeLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ clockInFlagged: false, clockInFlagReason: null }) }),
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
      mockPrisma.geofence.findMany.mockResolvedValue([]);
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
    mockPrisma.geofence.findMany.mockResolvedValue([fakeGeofence()]);
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
        data: expect.objectContaining({ clockOutPhotoId: 'file_2', clockOutFlagged: false, clockOutFlagReason: null }),
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

describe('POST /api/v1/dtr/check-location', () => {
  it('warns (flagged: true, reason: OUTSIDE_ALL_GEOFENCES) for a location outside every fence, leaking no geofence data', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('HOUSEKEEPING_STAFF'));
    mockPrisma.geofence.findMany.mockResolvedValue([fakeGeofence(), fakeGeofence(SATELLITE_SITE)]);

    const res = await request(createApp())
      .post('/api/v1/dtr/check-location')
      .set('Cookie', authCookie())
      .send({ lat: 0, lng: 0 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ flagged: true, reason: 'OUTSIDE_ALL_GEOFENCES' });
    // Privacy call: no name, no coordinates, no radius — just a verdict.
    expect(JSON.stringify(res.body)).not.toMatch(/Main Resort|Maria|centerLat|radiusMeters/);
  });

  it('warns (flagged: true, reason: NO_LOCATION) when no coordinates were provided at all', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('HOUSEKEEPING_STAFF'));
    mockPrisma.geofence.findMany.mockResolvedValue([fakeGeofence()]);

    const res = await request(createApp()).post('/api/v1/dtr/check-location').set('Cookie', authCookie()).send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ flagged: true, reason: 'NO_LOCATION' });
  });

  it('does not warn for a location inside any configured fence', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('HOUSEKEEPING_STAFF'));
    mockPrisma.geofence.findMany.mockResolvedValue([fakeGeofence(), fakeGeofence(SATELLITE_SITE)]);

    const res = await request(createApp())
      .post('/api/v1/dtr/check-location')
      .set('Cookie', authCookie())
      .send({ lat: 14.6001, lng: 120.9801 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ flagged: false, reason: null });
  });

  it('does not warn when the geofence list is empty, even with no location', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('HOUSEKEEPING_STAFF'));
    mockPrisma.geofence.findMany.mockResolvedValue([]);

    const res = await request(createApp()).post('/api/v1/dtr/check-location').set('Cookie', authCookie()).send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ flagged: false, reason: null });
  });

  it.each(['SYSTEM_ADMIN', 'OWNER', 'HOUSEKEEPING_STAFF', 'RESTAURANT_STAFF'])(
    'allows %s to pre-check a location — no shift:* permission required, same identity-only precedent as clock-in',
    async (roleKey) => {
      mockPrisma.user.findFirst.mockResolvedValue(userWithRole(roleKey));
      mockPrisma.geofence.findMany.mockResolvedValue([]);
      const res = await request(createApp()).post('/api/v1/dtr/check-location').set('Cookie', authCookie()).send({});
      expect(res.status).toBe(200);
    },
  );
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

  // Client follow-up, 2026-09-13: the "all time logs" audit view bounds
  // its query by date range so it never fetches unbounded history.
  it('applies from/to as a clockInAt range when the audit view passes them', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('RESORT_MANAGER'));
    mockPrisma.timeLog.findMany.mockResolvedValue([]);

    await request(createApp()).get('/api/v1/time-logs?from=2026-09-01&to=2026-09-13').set('Cookie', authCookie());

    const call = mockPrisma.timeLog.findMany.mock.calls[0]![0];
    expect(call.where.clockInAt.gte).toBeInstanceOf(Date);
    expect(call.where.clockInAt.lt).toBeInstanceOf(Date);
    expect(call.where.clockInAt.lt.getTime()).toBeGreaterThan(call.where.clockInAt.gte.getTime());
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

describe('GET/POST/PATCH/DELETE /api/v1/dtr/geofences', () => {
  it('allows system:configure to list geofences', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('SYSTEM_ADMIN'));
    mockPrisma.geofence.findMany.mockResolvedValue([fakeGeofence(), fakeGeofence(SATELLITE_SITE)]);

    const res = await request(createApp()).get('/api/v1/dtr/geofences').set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.geofences).toHaveLength(2);
    expect(mockPrisma.geofence.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { deletedAt: null } }),
    );
  });

  it('allows system:configure to add a named geofence', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('SYSTEM_ADMIN'));
    mockPrisma.geofence.create.mockResolvedValue(fakeGeofence(SATELLITE_SITE));

    const res = await request(createApp())
      .post('/api/v1/dtr/geofences')
      .set('Cookie', authCookie())
      .send({ name: "Maria's Home", centerLat: 14.60, centerLng: 120.98, radiusMeters: 150 });

    expect(res.status).toBe(201);
    expect(res.body.geofence.name).toBe("Maria's Home");
    expect(mockPrisma.geofence.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ name: "Maria's Home" }) }),
    );
  });

  it('rejects adding a geofence with a blank name', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('SYSTEM_ADMIN'));
    const res = await request(createApp())
      .post('/api/v1/dtr/geofences')
      .set('Cookie', authCookie())
      .send({ name: '', centerLat: 13.75, centerLng: 121.05, radiusMeters: 200 });
    expect(res.status).toBe(422);
    expect(mockPrisma.geofence.create).not.toHaveBeenCalled();
  });

  it('allows system:configure to edit a geofence', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('SYSTEM_ADMIN'));
    mockPrisma.geofence.findFirst.mockResolvedValue(fakeGeofence());
    mockPrisma.geofence.update.mockResolvedValue(fakeGeofence({ radiusMeters: 300 }));

    const res = await request(createApp())
      .patch('/api/v1/dtr/geofences/geo_1')
      .set('Cookie', authCookie())
      .send({ name: 'Main Resort', centerLat: 13.75, centerLng: 121.05, radiusMeters: 300 });

    expect(res.status).toBe(200);
    expect(res.body.geofence.radiusMeters).toBe(300);
  });

  it('404s editing a geofence that does not exist (or was already deleted)', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('SYSTEM_ADMIN'));
    mockPrisma.geofence.findFirst.mockResolvedValue(null);

    const res = await request(createApp())
      .patch('/api/v1/dtr/geofences/missing')
      .set('Cookie', authCookie())
      .send({ name: 'Main Resort', centerLat: 13.75, centerLng: 121.05, radiusMeters: 200 });

    expect(res.status).toBe(404);
    expect(mockPrisma.geofence.update).not.toHaveBeenCalled();
  });

  it('allows system:configure to delete (soft-delete) a geofence', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('SYSTEM_ADMIN'));
    mockPrisma.geofence.findFirst.mockResolvedValue(fakeGeofence());
    mockPrisma.geofence.update.mockResolvedValue(fakeGeofence({ deletedAt: new Date() }));

    const res = await request(createApp()).delete('/api/v1/dtr/geofences/geo_1').set('Cookie', authCookie());

    expect(res.status).toBe(204);
    expect(mockPrisma.geofence.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'geo_1' }, data: expect.objectContaining({ deletedAt: expect.any(Date) }) }),
    );
  });

  it('404s deleting a geofence that does not exist', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('SYSTEM_ADMIN'));
    mockPrisma.geofence.findFirst.mockResolvedValue(null);

    const res = await request(createApp()).delete('/api/v1/dtr/geofences/missing').set('Cookie', authCookie());

    expect(res.status).toBe(404);
    expect(mockPrisma.geofence.update).not.toHaveBeenCalled();
  });

  it.each(['RESORT_MANAGER', 'HOUSEKEEPING_STAFF', 'OWNER'])(
    'refuses %s — geofence management is system:configure only',
    async (roleKey) => {
      mockPrisma.user.findFirst.mockResolvedValue(userWithRole(roleKey));
      const res = await request(createApp()).get('/api/v1/dtr/geofences').set('Cookie', authCookie());
      expect(res.status).toBe(403);
    },
  );
});
