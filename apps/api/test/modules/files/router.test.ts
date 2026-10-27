import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalDiskStorageAdapter } from '../../../src/adapters/storage/localDiskStorageAdapter.js';

const mockPrisma = {
  user: { findFirst: vi.fn() },
  fileObject: { create: vi.fn(), findFirst: vi.fn() },
  auditLog: { create: vi.fn(), count: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
};

vi.mock('../../../src/lib/prisma.js', () => ({ prisma: mockPrisma }));

const mockStorageUpload = vi.fn();
let localAdapter: LocalDiskStorageAdapter;
vi.mock('../../../src/adapters/storage/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/adapters/storage/localDiskStorageAdapter.js')>(
    '../../../src/adapters/storage/localDiskStorageAdapter.js',
  );
  return {
    getStorageAdapter: () => localAdapter ?? { upload: mockStorageUpload },
    LocalDiskStorageAdapter: actual.LocalDiskStorageAdapter,
  };
});

const { createApp } = await import('../../../src/app.js');
const { signAccessToken } = await import('../../../src/modules/auth/tokens.js');

function userWithRole(roleKey: string) {
  return {
    id: 'user_1',
    employeeCode: 'LWW-010',
    fullName: 'Maintenance Technician (Demo)',
    email: null,
    department: 'MAINTENANCE',
    isActive: true,
    mustChangePassword: false,
    deletedAt: null,
    roles: [{ role: { key: roleKey } }],
  };
}

function authCookie() {
  return [`lwwbr_access=${signAccessToken('user_1')}`];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.auditLog.findFirst.mockResolvedValue(null);
  mockPrisma.auditLog.count.mockResolvedValue(0);
  mockPrisma.auditLog.findMany.mockResolvedValue([]);
});

describe('POST /api/v1/files', () => {
  it('requires authentication', async () => {
    const res = await request(createApp())
      .post('/api/v1/files')
      .attach('file', Buffer.from('fake-jpeg-bytes'), 'issue.jpg');
    expect(res.status).toBe(401);
  });

  it('uploads a valid image and creates a FileObject row', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('MAINTENANCE_STAFF'));
    mockStorageUpload.mockResolvedValue({ key: 'uploads/abc-issue.jpg', sizeBytes: 16, contentType: 'image/jpeg' });
    mockPrisma.fileObject.create.mockResolvedValue({
      id: 'file_1',
      filename: 'issue.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 16,
      storageKey: 'uploads/abc-issue.jpg',
    });

    const res = await request(createApp())
      .post('/api/v1/files')
      .set('Cookie', authCookie())
      .attach('file', Buffer.from('fake-jpeg-bytes'), 'issue.jpg');

    expect(res.status).toBe(201);
    expect(res.body.file).toEqual({ id: 'file_1', filename: 'issue.jpg', mimeType: 'image/jpeg', sizeBytes: 16 });
    expect(mockStorageUpload).toHaveBeenCalledWith(
      expect.objectContaining({ contentType: 'image/jpeg' }),
    );
  });

  it('rejects an unsupported MIME type (422), never touching storage', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('MAINTENANCE_STAFF'));

    const res = await request(createApp())
      .post('/api/v1/files')
      .set('Cookie', authCookie())
      .attach('file', Buffer.from('%PDF-1.4 fake pdf'), { filename: 'receipt.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(422);
    expect(mockStorageUpload).not.toHaveBeenCalled();
  });

  it('rejects when no file is attached', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userWithRole('MAINTENANCE_STAFF'));

    const res = await request(createApp()).post('/api/v1/files').set('Cookie', authCookie());

    expect(res.status).toBe(422);
  });
});

// Client decision, 2026-10-27 (spec.md §13 decision 11): this route is
// the local-disk StorageAdapter's own equivalent of a signed URL — see
// localDiskStorageAdapter.ts's header comment. Uses a real
// LocalDiskStorageAdapter against a temp directory (not a mock of the
// adapter itself), the same real-round-trip spirit as
// storage.local.roundtrip.test.ts, specifically because a real-URL,
// real-route mismatch (the route is mounted under /api/v1, an earlier
// version of getSignedUrl() minted a link without that prefix) was
// found manually, not by any mocked test — only exercising the actual
// route end to end catches that class of bug.
describe('GET /api/v1/files/signed', () => {
  let rootDir: string;
  const signingSecret = 'test-signing-secret-at-least-32-characters-long';

  beforeAll(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'lwwbr-files-router-'));
  });

  afterAll(async () => {
    await rm(rootDir, { recursive: true, force: true });
    localAdapter = undefined as unknown as LocalDiskStorageAdapter;
  });

  beforeEach(() => {
    localAdapter = new LocalDiskStorageAdapter(rootDir, signingSecret);
  });

  it('serves the exact bytes for a freshly minted signed URL, no auth required', async () => {
    const key = 'uploads/test-router-file.jpg';
    const contents = Buffer.from('fake-jpeg-bytes-for-router-test');
    await localAdapter.upload({ key, buffer: contents, contentType: 'image/jpeg' });
    mockPrisma.fileObject.findFirst.mockResolvedValue({ id: 'file_1', mimeType: 'image/jpeg' });

    const url = await localAdapter.getSignedUrl(key, 60);
    expect(url.startsWith('/api/v1/files/signed?')).toBe(true);

    const res = await request(createApp()).get(url).buffer(true).parse((response, callback) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => callback(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect((res.body as Buffer).toString()).toBe(contents.toString());
    expect(res.headers['content-type']).toContain('image/jpeg');
  });

  it('rejects a tampered signature with 403, never touching the database', async () => {
    const key = 'uploads/test-router-file-2.jpg';
    await localAdapter.upload({ key, buffer: Buffer.from('x'), contentType: 'image/jpeg' });
    const url = await localAdapter.getSignedUrl(key, 60);
    const tampered = url.replace(/sig=[0-9a-f]+$/, `sig=${'0'.repeat(64)}`);

    const res = await request(createApp()).get(tampered);

    expect(res.status).toBe(403);
    expect(mockPrisma.fileObject.findFirst).not.toHaveBeenCalled();
  });

  it('404s when STORAGE_ADAPTER resolves to something other than LocalDiskStorageAdapter', async () => {
    localAdapter = undefined as unknown as LocalDiskStorageAdapter; // falls back to the mockStorageUpload-only stub

    const res = await request(createApp()).get('/api/v1/files/signed?key=x&expires=9999999999999&sig=x');

    expect(res.status).toBe(404);
  });
});
