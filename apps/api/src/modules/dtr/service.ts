import { isWithinAnyGeofence } from '@lwwbr/shared';
import { TZDate } from '@date-fns/tz';
import { addDays } from 'date-fns';
import { getStorageAdapter } from '../../adapters/storage/index.js';
import { ApiError } from '../../lib/apiError.js';
import { prisma } from '../../lib/prisma.js';
import type {
  CheckLocationInput,
  ClockInInput,
  ClockOutInput,
  GeofenceInput,
  ListTimeLogsQuery,
  ReviewTimeLogInput,
} from './schema.js';

interface DtrActor {
  id: string;
}

// Client-directed feature, 2026-09-18: DTR (time in/out) with a selfie
// photo + geolocation capture on both clock-in and clock-out, checked
// against System-Admin-configured Geofence rows.
//
// The core design decision: a geofence miss NEVER blocks the clock-in/
// out, it only flags the entry for a shift:manage holder to review.
// Reasons, in order: (1) a denied/failed browser geolocation permission
// is common (old phone, privacy setting, dead GPS indoors) and must
// never stop someone from logging real hours; (2) even a genuine
// outside-every-fence location might be legitimate (an errand, a
// delivery run) — the server can't judge that, a human reviewing the
// flag can. So the only two outcomes are "not flagged" and "flagged,"
// never "rejected."
//
// If no geofence is configured at all, nothing is flagged for location
// reasons — there's nothing configured to check against yet, so an
// unconfigured property shouldn't have every clock-in/out show up as
// suspicious.
//
// Client follow-up, 2026-09-13, three changes in one slice:
// (1) multiple named Geofence rows, not one Setting value — "inside any
//     one counts," and any configured location works for anyone (not
//     tied to a specific employee — client's explicit call, so Geofence
//     has no userId).
// (2) the client now pre-checks a clock-in/out's location (checkLocation
//     below) so the UI can warn the person in the moment, before they
//     submit, instead of only a reviewer finding out later. The actual
//     clock-in/out still re-evaluates authoritatively server-side — the
//     pre-check is a UX convenience, never the source of truth, and
//     deliberately returns no geofence data (names/coordinates), only a
//     flagged/reason verdict, so an employee can't enumerate the
//     property's configured locations (some of which, per the client's
//     own example, may be a person's home address) just by probing this
//     endpoint.
// (3) clockInFlagReason/clockOutFlagReason distinguish NO_LOCATION (the
//     browser never provided one) from OUTSIDE_ALL_GEOFENCES (it did,
//     but missed every configured fence) — see the enum's own schema
//     comment for why this doesn't need a separate signal for "nothing
//     was configured": that case never flags at all.
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

async function listActiveGeofences() {
  return prisma.geofence.findMany({ where: { deletedAt: null }, orderBy: { name: 'asc' } });
}

async function validatePhoto(photoFileId: string) {
  const file = await prisma.fileObject.findFirst({ where: { id: photoFileId, deletedAt: null } });
  if (!file) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'The referenced photo could not be found.');
  }
}

type FlagReason = 'NO_LOCATION' | 'OUTSIDE_ALL_GEOFENCES';

// Flags only when at least one Geofence is configured and the location
// is either missing (can't be verified) or outside every one of them —
// see this module's own header comment.
async function evaluateLocation(
  lat: number | undefined,
  lng: number | undefined,
): Promise<{ flagged: boolean; reason: FlagReason | null }> {
  const geofences = await listActiveGeofences();
  if (geofences.length === 0) return { flagged: false, reason: null };
  if (lat === undefined || lng === undefined) return { flagged: true, reason: 'NO_LOCATION' };
  const inside = isWithinAnyGeofence(lat, lng, geofences);
  return inside ? { flagged: false, reason: null } : { flagged: true, reason: 'OUTSIDE_ALL_GEOFENCES' };
}

export async function checkLocation(input: CheckLocationInput) {
  return evaluateLocation(input.lat, input.lng);
}

export async function clockIn(input: ClockInInput, actor: DtrActor) {
  await validatePhoto(input.photoFileId);

  const openEntry = await prisma.timeLog.findFirst({
    where: { userId: actor.id, clockOutAt: null, deletedAt: null },
  });
  if (openEntry) {
    throw new ApiError(409, 'ALREADY_CLOCKED_IN', 'You already have an open clock-in — clock out before clocking in again.');
  }

  const { flagged, reason } = await evaluateLocation(input.lat, input.lng);
  const timeLog = await prisma.timeLog.create({
    data: {
      userId: actor.id,
      clockInAt: new Date(),
      source: 'WEB',
      clockInPhotoId: input.photoFileId,
      clockInLat: input.lat,
      clockInLng: input.lng,
      clockInFlagged: flagged,
      clockInFlagReason: reason,
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

  const { flagged, reason } = await evaluateLocation(input.lat, input.lng);
  const timeLog = await prisma.timeLog.update({
    where: { id: openEntry.id },
    data: {
      clockOutAt: new Date(),
      clockOutPhotoId: input.photoFileId,
      clockOutLat: input.lat,
      clockOutLng: input.lng,
      clockOutFlagged: flagged,
      clockOutFlagReason: reason,
    },
    include: TIME_LOG_INCLUDE,
  });
  return timeLogToJson(timeLog);
}

interface ListTimeLogsActor {
  id: string;
  canManage: boolean;
}

const RESORT_TIMEZONE = 'Asia/Manila';

// Same calendar-date-in-Asia/Manila resolution as reports/service.ts's
// own resolveDate — from/to here are calendar dates the client typed,
// not however UTC midnight happens to line up.
function resolveDate(dateStr: string): Date {
  const [year, month, day] = dateStr.split('-').map(Number) as [number, number, number];
  return new TZDate(year, month - 1, day, 0, 0, RESORT_TIMEZONE);
}

// Self-scoped unless the caller holds shift:manage — same "the query
// can't be used to see someone else's records without the matching
// permission" rule as restday/service.ts's listRestDayRequests.
// from/to (client follow-up, 2026-09-13) only matter to the new "all
// time logs" audit view a shift:manage holder uses; the self-scoped
// "my recent time logs" list never sends them.
export async function listTimeLogs(query: ListTimeLogsQuery, actor: ListTimeLogsActor) {
  const scopedToSelf = !actor.canManage;
  const from = query.from ? resolveDate(query.from) : undefined;
  const to = query.to ? addDays(resolveDate(query.to), 1) : undefined;
  const timeLogs = await prisma.timeLog.findMany({
    where: {
      deletedAt: null,
      ...(scopedToSelf ? { userId: actor.id } : query.userId ? { userId: query.userId } : {}),
      ...(query.flaggedOnly ? { OR: [{ clockInFlagged: true }, { clockOutFlagged: true }] } : {}),
      ...(from || to ? { clockInAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } : {}),
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

export async function listGeofences() {
  return listActiveGeofences();
}

export async function createGeofence(input: GeofenceInput) {
  return prisma.geofence.create({ data: input });
}

export async function updateGeofence(id: string, input: GeofenceInput) {
  const existing = await prisma.geofence.findFirst({ where: { id, deletedAt: null } });
  if (!existing) {
    throw new ApiError(404, 'NOT_FOUND', 'Geofence not found');
  }
  return prisma.geofence.update({ where: { id }, data: input });
}

export async function deleteGeofence(id: string) {
  const existing = await prisma.geofence.findFirst({ where: { id, deletedAt: null } });
  if (!existing) {
    throw new ApiError(404, 'NOT_FOUND', 'Geofence not found');
  }
  await prisma.geofence.update({ where: { id }, data: { deletedAt: new Date() } });
}
