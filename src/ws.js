import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

/** Server -> client frame (never masked). */
export function encodeFrame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let head;
  if (body.length < 126) head = Buffer.from([0x80 | opcode, body.length]);
  else if (body.length < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(body.length, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(body.length), 2); }
  return Buffer.concat([head, body]);
}
export const encodeText = (s) => encodeFrame(0x1, s);
export const encodeClose = (code = 1000) => { const b = Buffer.alloc(2); b.writeUInt16BE(code); return encodeFrame(0x8, b); };

/**
 * Minimal RFC 6455 reader for client frames. Calls onMessage(isBinary, buffer), onPing(buffer),
 * onClose(). Throws on protocol errors / oversized messages so the caller can drop the socket.
 */
export class FrameParser {
  constructor({ onMessage, onPing, onClose, maxMessage = 8 * 1024 * 1024 }) {
    Object.assign(this, { onMessage, onPing, onClose, maxMessage });
    this.buf = Buffer.alloc(0);
    this.parts = []; this.partsLen = 0; this.partOp = 0;
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const op = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f; let off = 2;
      if (!masked) throw new Error('unmasked client frame');
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (b.length < 10) return;
        const big = b.readBigUInt64BE(2);
        if (big > BigInt(this.maxMessage)) throw new Error('frame too large');
        len = Number(big); off = 10;
      }
      if (len > this.maxMessage) throw new Error('frame too large');
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4);
      const data = Buffer.from(b.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      this.buf = b.subarray(off + 4 + len);

      if (op >= 0x8) {
        if (op === 0x8) this.onClose();
        else if (op === 0x9) this.onPing(data);
        continue;
      }
      if (op !== 0x0) { this.parts = []; this.partsLen = 0; this.partOp = op; }
      this.parts.push(data); this.partsLen += data.length;
      if (this.partsLen > this.maxMessage) throw new Error('message too large');
      if (fin) {
        const whole = this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts);
        this.parts = []; this.partsLen = 0;
        this.onMessage(this.partOp === 0x2, whole);
      }
    }
  }
}

/** Completes the WebSocket handshake; returns false (and closes the socket) when it is not one. */
export function handshake(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || !key) {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); socket.destroy(); return false;
  }
  socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${acceptKey(key)}`, '', ''].join('\r\n'));
  socket.setNoDelay(true);
  return true;
}

/** Browsers always send Origin on WebSocket handshakes: it must be this very site. */
export function sameOrigin(req) {
  try { const o = req.headers.origin; return !!o && new URL(o).host === req.headers.host; } catch { return false; }
}
