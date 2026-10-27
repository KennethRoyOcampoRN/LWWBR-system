import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { prisma } from '../../lib/prisma.js';
import { verifyAccessToken } from '../../modules/auth/tokens.js';

const ACCESS_COOKIE = 'lwwbr_access';

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name) out[name] = decodeURIComponent(value);
  }
  return out;
}

// Client decision, 2026-10-27 (spec.md §13 decision 11): spec §9.1's
// original Socket.IO design, returned to rather than reinvented —
// namespace /rt, join user:{id}/dept:{department}/property on connect.
//
// Auth happens once, at the handshake, not per-event: the same access-
// token cookie requireAuth already verifies (a same-origin WebSocket
// carries cookies automatically). A connection with no/invalid/expired
// token is refused outright (the handshake itself fails) rather than
// connected-but-silently-unauthenticated — and because room membership
// is decided here from the verified token's own user id/department,
// never from anything the client sends, a socket can't join someone
// else's user:{id} room by just asking for it.
export function attachSocketIoServer(httpServer: HttpServer): Server {
  const io = new Server(httpServer, { path: '/rt' });

  io.use((socket, next) => {
    const cookies = parseCookies(socket.handshake.headers.cookie);
    const token = cookies[ACCESS_COOKIE];
    const payload = token ? verifyAccessToken(token) : null;
    if (!payload) {
      next(new Error('UNAUTHENTICATED'));
      return;
    }
    prisma.user
      .findFirst({ where: { id: payload.sub, deletedAt: null }, select: { department: true } })
      .then((user) => {
        if (!user) {
          next(new Error('UNAUTHENTICATED'));
          return;
        }
        socket.data.userId = payload.sub;
        socket.data.department = user.department;
        next();
      })
      .catch((error: unknown) => next(error instanceof Error ? error : new Error(String(error))));
  });

  io.on('connection', (socket) => {
    socket.join('property');
    socket.join(`user:${socket.data.userId as string}`);
    socket.join(`dept:${socket.data.department as string}`);
  });

  return io;
}
