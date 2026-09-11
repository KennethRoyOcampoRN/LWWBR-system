import { haversineDistanceMeters } from '@lwwbr/shared';
import { getStorageAdapter } from '../../adapters/storage/index.js';
import { ApiError } from '../../lib/apiError.js';
import { prisma } from '../../lib/prisma.js';
import type {
  ClockInInput,
  ClockOutInput,
  GeofenceSettingInput,
  ListTimeLogsQuery,
  ReviewTimeLogInput,
} from './schema.js';

const GEOFENCE_SETTING_KEY = 'dtr.geofence';

interface DtrActor {
  id: string;
}

// Client-directed feature, 2026-09-18: DTR (time in/out) with a selfie
// photo + geolocation capture on both clock-in and clock-out, checked
// against a System-Admin-configured geofence (Setting key
// "dtr.geofence": {centerLat, centerLng, radiusMeters}).
//
// The core design decision: a geofence miss NEVER blocks the clock-in/
// out, it only flags the entry for a shift:manage holder to review.
// Reasons, in order: (1) a denied/failed browser geolocation permission
// is common (old phone, privacy setting, dead GPS indoors) and must
// never stop someone from logging real hours; (2) even a genuine
// outside-the-fence location might be legitimate (an errand, a delivery
// run) — the server can't judge that, a human reviewing the flag can.
// So the only two outcomes are "not flagged" and "flagged," never
// "rejected."
//
// If no geofence is configured at all, nothing is flagged for location
// reasons — there's nothing configured to check against yet, so an
// unconfigured property shouldn't have every clock-in/out show up as
// suspicious.
const CLOCK_EVENT_PHOTO_INCLUDE = {
  select: { id: true, filename: true, mimeType: true, storageKey: true },
} as const;

const TIME_LOG_INCLUDE = {
  user: { select: { id: true, fullName: true } },
  clockInPhoto: CLOCK_EVENT_PHOTO_INCLUDE,
  clockOutPhoto: CLOCK_EVENT_PHOTO_INCLUDE,
  reviewedBy: { select: { id: true, fullName: true } },
} as const;

type RawPhoto = { id: string; filename: string; mimeType: string; storageKey: string } | null;

// Same signed-URL-not-raw-storageKey reasoning as remittances/
// service.ts's remittanceRequestToJson — there is no generic
// GET /files/:id route, so a real signed URL generated here is the only
// way a caller can ever view the photo.
async function photoToJson(photo: RawPhoto) {
  if (!photo) return null;
  return {
    id: photo.id,
    filename: photo.filename,
    mimeType: photo.mimeType,
    url: await getStorageAdapter().getSignedUrl(photo.storageKey),
  };
}

async function timeLogToJson<
  T extends { clockInPhoto: RawPhoto; clockOutPhoto: RawPhoto },
>(timeLog: T) {
  const { clockInPhoto, clockOutPhoto, ...rest } = timeLog;
  return {
    ...rest,
    clockInPhoto: await photoToJson(clockInPhoto),
    clockOutPhoto: await photoToJson(clockOutPhoto),
  };
}

async function getGeofence(): Promise<GeofenceSettingInput | null> {
  const setting = await prisma.setting.findUnique({ where: { key: GEOFENCE_SETTING_KEY } });
  if (!setting) return null;
  return setting.value as unknown as GeofenceSettingInput;
}

async function validatePhoto(photoFileId: string) {
  const file = await prisma.fileObject.findFirst({ where: { id: photoFileId, deletedAt: null } });
  if (!file) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'The referenced photo could not be found.');
  }
}

// Flags only when a geofence IS configured and the location is either
// missing (can't be verified) or outside the configured radius —
// see this module's own header comment.
async function computeFlagged(lat: number | undefined, lng: number | undefined): Promise<boolean> {
  const geofence = await getGeofence();
  if (!geofence) return false;
  if (lat === undefined || lng === undefined) return true;
  return haversineDistanceMeters(lat, lng, geofence.centerLat, geofence.centerLng) > geofence.radiusMeters;
}

export async function clockIn(input: ClockInInput, actor: DtrActor) {
  await validatePhoto(input.photoFileId);

  const openEntry = await prisma.timeLog.findFirst({
    where: { userId: actor.id, clockOutAt: null, deletedAt: null },
  });
  if (openEntry) {
    throw new ApiError(409, 'ALREADY_CLOCKED_IN', 'You already have an open clock-in — clock out before clocking in again.');
  }

  const flagged = await computeFlagged(input.lat, input.lng);
  const timeLog = await prisma.timeLog.create({
    data: {
      userId: actor.id,
      clockInAt: new Date(),
      source: 'WEB',
      clockInPhotoId: input.photoFileId,
      clockInLat: input.lat,
      clockInLng: input.lng,
      clockInFlagged: flagged,
    },
    include: TIME_LOG_INCLUDE,
  });
  return timeLogToJson(timeLog);
}

export async function clockOut(input: ClockOutInput, actor: DtrActor) {
  await validatePhoto(input.photoFileId);

  const openEntry = await prisma.timeLog.findFirst({
    where: { userId: actor.id, clockOutAt: null, deletedAt: null },
  });
  if (!openEntry) {
    throw new ApiError(409, 'NOT_CLOCKED_IN', 'You have no open clock-in to clock out from.');
  }

  const flagged = await computeFlagged(input.lat, input.lng);
  const timeLog = await prisma.timeLog.update({
    where: { id: openEntry.id },
    data: {
      clockOutAt: new Date(),
      clockOutPhotoId: input.photoFileId,
      clockOutLat: input.lat,
      clockOutLng: input.lng,
      clockOutFlagged: flagged,
    },
    include: TIME_LOG_INCLUDE,
  });
  return timeLogToJson(timeLog);
}

interface ListTimeLogsActor {
  id: string;
  canManage: boolean;
}

// Self-scoped unless the caller holds shift:manage — same "the query
// can't be used to see someone else's records without the matching
// permission" rule as restday/service.ts's listRestDayRequests.
export async function listTimeLogs(query: ListTimeLogsQuery, actor: ListTimeLogsActor) {
  const scopedToSelf = !actor.canManage;
  const timeLogs = await prisma.timeLog.findMany({
    where: {
      deletedAt: null,
      ...(scopedToSelf ? { userId: actor.id } : query.userId ? { userId: query.userId } : {}),
      ...(query.flaggedOnly ? { OR: [{ clockInFlagged: true }, { clockOutFlagged: true }] } : {}),
    },
    include: TIME_LOG_INCLUDE,
    orderBy: [{ clockInAt: 'desc' }],
  });
  return Promise.all(timeLogs.map(timeLogToJson));
}

// Flagged-entries queue for a shift:manage holder — unreviewed rows
// only (reviewedAt null). Reviewing clears both flags' review state at
// once (one review pass covers whichever of clock-in/clock-out was
// flagged on that row), not two separate actions.
export async function listFlaggedTimeLogs() {
  const timeLogs = await prisma.timeLog.findMany({
    where: {
      deletedAt: null,
      reviewedAt: null,
      OR: [{ clockInFlagged: true }, { clockOutFlagged: true }],
    },
    include: TIME_LOG_INCLUDE,
    orderBy: [{ clockInAt: 'asc' }],
  });
  return Promise.all(timeLogs.map(timeLogToJson));
}

export async function reviewTimeLog(id: string, input: ReviewTimeLogInput, actor: DtrActor) {
  const existing = await prisma.timeLog.findFirst({ where: { id, deletedAt: null } });
  if (!existing) {
    throw new ApiError(404, 'NOT_FOUND', 'Time log entry not found');
  }
  if (!existing.clockInFlagged && !existing.clockOutFlagged) {
    throw new ApiError(409, 'NOT_FLAGGED', 'This entry was never flagged — nothing to review.');
  }
  const timeLog = await prisma.timeLog.update({
    where: { id },
    data: { reviewedById: actor.id, reviewedAt: new Date(), reviewNote: input.reviewNote },
    include: TIME_LOG_INCLUDE,
  });
  return timeLogToJson(timeLog);
}

export async function getGeofenceSetting() {
  return getGeofence();
}

export async function setGeofenceSetting(input: GeofenceSettingInput, actor: DtrActor) {
  await prisma.setting.upsert({
    where: { key: GEOFENCE_SETTING_KEY },
    create: { key: GEOFENCE_SETTING_KEY, value: input, updatedById: actor.id },
    update: { value: input, updatedById: actor.id },
  });
  return input;
}
