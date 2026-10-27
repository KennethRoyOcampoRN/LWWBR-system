import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockPrisma = { user: { findFirst: vi.fn() } };
vi.mock('../../src/lib/prisma.js', () => ({ prisma: mockPrisma }));

process.env.JWT_SECRET ??= 'test-jwt-secret-at-least-32-characters-long-ok';
// getEnv() requires these regardless of what this test actually touches
// — set them locally rather than depending on another test file having
// run first and populated the module-level getEnv() cache.
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.DIRECT_URL ??= 'postgresql://test:test@localhost:5432/test';

const { attachSocketIoServer } = await import('../../src/adapters/realtime/socketIoServer.js');
const { SocketIoRealtimeAdapter } = await import('../../src/adapters/realtime/socketIoRealtimeAdapter.js');
const { signAccessToken } = await import('../../src/modules/auth/tokens.js');
const { io: ioClient } = await import('socket.io-client');

// Client decision, 2026-10-27 (spec.md §13 decision 11): unlike the
// Supabase round-trip test above, this needs no hosted credentials — a
// real http.Server + a real socket.io-client against it, both local —
// so it actually runs (not skipped) in every environment, this sandbox
// included. See socketIoServer.ts's own header comment for the auth
// design this exercises.
describe('SocketIoRealtimeAdapter round-trip', () => {
  let httpServer: ReturnType<typeof createServer>;
  let port: number;

  beforeEach(async () => {
    vi.clearAllMocks();
    httpServer = createServer();
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    port = (httpServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it('a broadcast emitted on a room a client has joined is received by that client', async () => {
    mockPrisma.user.findFirst.mockResolvedValue({ department: 'HOUSEKEEPING' });
    const io = attachSocketIoServer(httpServer);
    const token = signAccessToken('user_test');

    const client = ioClient(`http://localhost:${port}`, {
      path: '/rt',
      transports: ['websocket'],
      extraHeaders: { Cookie: `lwwbr_access=${token}` },
    });

    await new Promise<void>((resolve, reject) => {
      client.on('connect', () => resolve());
      client.on('connect_error', reject);
    });

    const received = new Promise<{ entityId: string; summary: string }>((resolve) => {
      client.on('unit.status.changed', (payload) => resolve(payload));
    });

    const adapter = new SocketIoRealtimeAdapter(io);
    await adapter.emit('property', 'unit.status.changed', {
      entityId: 'unit_test',
      actorId: 'user_test',
      at: new Date().toISOString(),
      summary: 'Room R01 moved to CLEANING',
    });

    const payload = await received;
    expect(payload.entityId).toBe('unit_test');
    expect(payload.summary).toContain('R01');

    client.disconnect();
    io.close();
  });

  // The part Supabase's own single global channel never had to prove:
  // room membership is decided server-side from the verified token, so
  // a connected client can't be made to receive a broadcast aimed at
  // someone else's user:{id} room just because it knows the room name.
  it('a broadcast on a different user\'s own room is never received by this client', async () => {
    mockPrisma.user.findFirst.mockResolvedValue({ department: 'HOUSEKEEPING' });
    const io = attachSocketIoServer(httpServer);
    const token = signAccessToken('user_test');

    const client = ioClient(`http://localhost:${port}`, {
      path: '/rt',
      transports: ['websocket'],
      extraHeaders: { Cookie: `lwwbr_access=${token}` },
    });
    await new Promise<void>((resolve, reject) => {
      client.on('connect', () => resolve());
      client.on('connect_error', reject);
    });

    const receivedHandler = vi.fn();
    client.on('notification.new', receivedHandler);

    const adapter = new SocketIoRealtimeAdapter(io);
    await adapter.emit('user:someone_else', 'notification.new', {
      entityId: 'notif_test',
      actorId: 'user_test',
      at: new Date().toISOString(),
      summary: 'test',
    });
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(receivedHandler).not.toHaveBeenCalled();

    client.disconnect();
    io.close();
  });

  it('refuses a connection with no access token', async () => {
    attachSocketIoServer(httpServer);
    const client = ioClient(`http://localhost:${port}`, {
      path: '/rt',
      transports: ['websocket'],
    });

    const error = await new Promise<Error>((resolve) => {
      client.on('connect_error', (err) => resolve(err));
    });
    expect(error.message).toContain('UNAUTHENTICATED');

    client.disconnect();
  });

  it('refuses a connection for a user that no longer exists', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(null);
    attachSocketIoServer(httpServer);
    const token = signAccessToken('user_deleted');

    const client = ioClient(`http://localhost:${port}`, {
      path: '/rt',
      transports: ['websocket'],
      extraHeaders: { Cookie: `lwwbr_access=${token}` },
    });

    const error = await new Promise<Error>((resolve) => {
      client.on('connect_error', (err) => resolve(err));
    });
    expect(error.message).toContain('UNAUTHENTICATED');

    client.disconnect();
  });
});
