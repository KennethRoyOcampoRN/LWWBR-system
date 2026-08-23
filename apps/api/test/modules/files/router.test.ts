import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPrisma = {
  user: { findFirst: vi.fn() },
  fileObject: { create: vi.fn() },
  auditLog: { create: vi.fn(), count: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
};

vi.mock('../../../src/lib/prisma.js', () => ({ prisma: mockPrisma }));

const mockStorageUpload = vi.fn();
vi.mock('../../../src/adapters/storage/index.js', () => ({
  getStorageAdapter: () => ({ upload: mockStorageUpload }),
}));

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
