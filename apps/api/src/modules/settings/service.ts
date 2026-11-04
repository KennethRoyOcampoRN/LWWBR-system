import { getStorageAdapter } from '../../adapters/storage/index.js';
import { ApiError } from '../../lib/apiError.js';
import { prisma } from '../../lib/prisma.js';
import type { ResortIdentityInput } from './schema.js';

// Build plan stage 2 (spec.md §13 decision 13, 2026-11-04): the Setting
// key a Receipt's resort-header snapshot is sourced from — see
// workorders/service.ts's PHOTO_REQUIREMENTS_SETTING_KEY for the
// established read-a-Setting-row pattern this follows (findUnique, fall
// back to a default when the row doesn't exist yet rather than crash).
const RESORT_IDENTITY_SETTING_KEY = 'resort.identity';

interface ResortIdentityValue {
  name: string;
  address: string;
  cellNo: string | null;
  contactNo: string | null;
  website: string | null;
  facebookUrl: string | null;
  logoFileId: string | null;
}

const DEFAULT_RESORT_IDENTITY: ResortIdentityValue = {
  name: '',
  address: '',
  cellNo: null,
  contactNo: null,
  website: null,
  facebookUrl: null,
  logoFileId: null,
};

async function getResortIdentityValue(): Promise<ResortIdentityValue> {
  const setting = await prisma.setting.findUnique({ where: { key: RESORT_IDENTITY_SETTING_KEY } });
  if (!setting) {
    return DEFAULT_RESORT_IDENTITY;
  }
  return setting.value as unknown as ResortIdentityValue;
}

// Same signed-URL-not-raw-storageKey reasoning as dtr/service.ts's own
// photoToJson — there is no generic GET /files/:id route, so a real
// signed URL generated here is the only way the settings page can ever
// show the current logo.
async function logoToJson(logoFileId: string | null) {
  if (!logoFileId) return null;
  const file = await prisma.fileObject.findFirst({ where: { id: logoFileId, deletedAt: null } });
  if (!file) return null;
  return {
    id: file.id,
    filename: file.filename,
    mimeType: file.mimeType,
    url: await getStorageAdapter().getSignedUrl(file.storageKey),
  };
}

export async function getResortIdentity() {
  const value = await getResortIdentityValue();
  const { logoFileId, ...rest } = value;
  return { ...rest, logo: await logoToJson(logoFileId) };
}

// Receipt's own issuance service (build plan stage 3) reads this
// directly, not getResortIdentity() above — it needs the raw
// logoFileId to snapshot onto Receipt.logoFileId, not a signed URL that
// would expire long before the receipt is ever reprinted.
export async function getResortIdentityForSnapshot(): Promise<ResortIdentityValue> {
  return getResortIdentityValue();
}

export async function updateResortIdentity(input: ResortIdentityInput, actorId: string) {
  if (input.logoFileId) {
    const file = await prisma.fileObject.findFirst({ where: { id: input.logoFileId, deletedAt: null } });
    if (!file) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'The referenced logo file could not be found.');
    }
  }

  const value: ResortIdentityValue = {
    name: input.name,
    address: input.address,
    cellNo: input.cellNo ?? null,
    contactNo: input.contactNo ?? null,
    website: input.website ?? null,
    facebookUrl: input.facebookUrl ?? null,
    logoFileId: input.logoFileId ?? null,
  };

  await prisma.setting.upsert({
    where: { key: RESORT_IDENTITY_SETTING_KEY },
    update: { value: value as object, updatedById: actorId },
    create: { key: RESORT_IDENTITY_SETTING_KEY, value: value as object, updatedById: actorId },
  });

  return getResortIdentity();
}
