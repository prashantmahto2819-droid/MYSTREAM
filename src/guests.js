import { randomToken } from './crypto.js';
import { encodeText, encodeClose, encodeFrame, FrameParser, handshake, sameOrigin } from './ws.js';

const INVITE_TTL_MS = 6 * 3600 * 1000;
const MAX_GUESTS = 3;

/**
 * Signalling only: guests send their camera/mic straight to the host's browser (WebRTC), the
 * server just passes offer/answer/ICE messages between them. Invite links work only while the
 * host has the studio open, expire after 6 hours and are tied to one user.
 */
export function attachGuests(server, { store, parseCookies, log = console, now = Date.now }) {
  const rooms = new Map(); // token -> { userId, expires, host, guests: Map(id -> {socket,name}), nextId }

  const sweep = () => { for (const [t, r] of rooms) if (r.expires < now() && !r.host) rooms.delete(t); };

  function createInvite(userId) {
    sweep();
    for (const [t, r] of rooms) if (r.userId === userId && r.expires > now()) return { token: t, reused: true };
    const token = randomToken(12);
    rooms.set(token, { userId, expires: now() + INVITE_TTL_MS, host: null, guests: new Map(), nextId: 1 });
    return { token, reused: false };
  }
  function revokeInvite(userId) {
    for (const [t, r] of rooms) if (r.userId === userId) { for (const g of r.guests.values()) g.socket.end(encodeClose(1000)); r.host?.end(encodeClose(1000)); rooms.delete(t); }
  }

  const sendObj = (socket, obj) => { if (!socket.destroyed) socket.write(encodeText(JSON.stringify(obj))); };
  const reader = (socket, onText, onDone) => {
    const parser = new FrameParser({
      maxMessage: 64 * 1024,
      onPing: (d) => socket.write(encodeFrame(0xA, d)),
      onClose: () => socket.end(encodeClose(1000)),
      onMessage: (bin, d) => { if (!bin) { try { onText(JSON.parse(d.toString())); } catch { /* ignore bad json */ } } },
    });
    socket.on('data', (c) => { try { parser.push(c); } catch { socket.destroy(); } });
    socket.on('end', () => socket.destroy()); // http servers keep half-open sockets: a closed tab must end the session
    socket.on('close', onDone); socket.on('error', () => {});
  };

  server.on('upgrade', (req, socket) => {
    let url; try { url = new URL(req.url, 'http://x'); } catch { return; }
    const isHost = url.pathname === '/api/guest/host';
    const isGuest = url.pathname === '/api/guest/join';
    if (!isHost && !isGuest) return;
    req.wsHandled = true;
    const bye = (code, msg) => { socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\n\r\n`); socket.destroy(); };
    if (!sameOrigin(req)) return bye(403, 'Forbidden');
    const room = rooms.get(url.searchParams.get('token') || '');
    if (!room || room.expires < now()) return bye(404, 'Not Found');

    if (isHost) {
      const user = store.getSessionUser(parseCookies(req).sid);
      if (!user || !user.active || user.id !== room.userId) return bye(401, 'Unauthorized');
      if (!handshake(req, socket)) return;
      if (room.host) { sendObj(room.host, { type: 'error', message: 'Studio opened in another tab.' }); room.host.end(encodeClose(1000)); }
      room.host = socket;
      sendObj(socket, { type: 'host-ready', guests: [...room.guests].map(([id, g]) => ({ id, name: g.name })) });
      reader(socket, (m) => {
        const g = room.guests.get(Number(m.to));
        if (g && m.signal) sendObj(g.socket, { type: 'signal', signal: m.signal });
        else if (g && m.type === 'kick') { sendObj(g.socket, { type: 'kicked' }); g.socket.end(encodeClose(1000)); }
      }, () => {
        if (room.host === socket) {
          room.host = null;
          for (const g of room.guests.values()) { sendObj(g.socket, { type: 'host-left' }); g.socket.end(encodeClose(1000)); }
        }
      });
      return;
    }

    // guest
    if (!room.host) return bye(409, 'Host not in studio');
    if (room.guests.size >= MAX_GUESTS) return bye(429, 'Studio is full');
    if (!handshake(req, socket)) return;
    const id = room.nextId++;
    const name = String(url.searchParams.get('name') || 'Guest').trim().slice(0, 40) || 'Guest';
    room.guests.set(id, { socket, name });
    sendObj(socket, { type: 'welcome', id, name });
    sendObj(room.host, { type: 'guest-joined', id, name });
    reader(socket, (m) => { if (m.signal && room.host) sendObj(room.host, { type: 'signal', from: id, signal: m.signal }); }, () => {
      if (room.guests.delete(id) && room.host) sendObj(room.host, { type: 'guest-left', id });
    });
  });

  return { createInvite, revokeInvite, rooms };
}
