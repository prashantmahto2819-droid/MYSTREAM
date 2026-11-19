import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { openDb } from '../src/db.js';
import { makeVault } from '../src/crypto.js';
import { createApp } from '../src/server.js';
import { RelayManager } from '../src/relay.js';
import { buildStudioArgs } from '../src/studio.js';
import { encodeText, FrameParser, acceptKey } from '../src/ws.js';

const quiet = { error() {}, warn() {}, info() {} };

function maskedFrame(opcode, payload, { fin = true } = {}) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const mask = crypto.randomBytes(4);
  let head;
  if (body.length < 126) head = Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | body.length]);
  else if (body.length < 65536) { head = Buffer.alloc(4); head[0] = (fin ? 0x80 : 0) | opcode; head[1] = 0x80 | 126; head.writeUInt16BE(body.length, 2); }
  else { head = Buffer.alloc(10); head[0] = (fin ? 0x80 : 0) | opcode; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(body.length), 2); }
  const m = Buffer.from(body); for (let i = 0; i < m.length; i++) m[i] ^= mask[i & 3];
  return Buffer.concat([head, mask, m]);
}

test('ws: accept key matches RFC example, parser handles 16-bit lengths, fragments and masks', () => {
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  const got = [];
  const p = new FrameParser({ onMessage: (bin, d) => got.push([bin, d]), onPing() {}, onClose() {} });
  const big = Buffer.alloc(70000, 7);
  const f1 = maskedFrame(0x2, big);
  p.push(f1.subarray(0, 5)); p.push(f1.subarray(5)); // split across chunks
  p.push(Buffer.concat([maskedFrame(0x1, 'hel', { fin: false }), maskedFrame(0x0, 'lo')]));
  assert.equal(got[0][0], true); assert.equal(got[0][1].length, 70000); assert.ok(got[0][1].every((x) => x === 7));
  assert.deepEqual(got[1], [false, Buffer.from('hello')]);
  assert.throws(() => p.push(Buffer.from([0x81, 0x01, 0x41])), /unmasked/);
  assert.equal(encodeText('hi').length, 4);
});

test('studio args: reads webm from stdin, 2 s keyframes, silent track when no audio', () => {
  const a = buildStudioArgs({ output: 'rtmp://x/live/k', height: 720 });
  assert.ok(a.includes('pipe:0') && a.includes('libx264') && a.includes('aac'));
  assert.equal(a.at(-1), 'rtmp://x/live/k');
  assert.equal(a[a.indexOf('-g') + 1], '60');
  assert.ok(!a.includes('anullsrc=r=44100:cl=stereo'));
  const n = buildStudioArgs({ output: 'o', hasAudio: false });
  assert.ok(n.includes('anullsrc=r=44100:cl=stereo') && n.includes('1:a:0'));
  assert.equal(n.at(-1), 'o');
});

async function boot() {
  const store = openDb(':memory:');
  const vault = makeVault('s'.repeat(20));
  const uid = store.createUser({ email: 'a@x.com', name: 'A', passwordHash: 'h' });
  const user = store.getUser(uid);
  const d1 = store.createDestination({ userId: uid, name: 'YT', platform: 'youtube', rtmpUrl: 'rtmp://a.example.com/x', keyEnc: vault.encrypt('k1k1k') });
  const d2 = store.createDestination({ userId: uid, name: 'FB', platform: 'facebook', rtmpUrl: 'rtmp://b.example.com/x', keyEnc: vault.encrypt('k2k2k') });
  const sid = null;
  const cfg = { mediamtxApi: 'http://m', mediamtxRtmp: 'rtmp://m:1935', ffmpegBin: 'ffmpeg', pollMs: 1000, backoffBaseMs: 20, backoffMaxMs: 80, stableMs: 30, publicRtmpUrl: 'rtmp://r/live', maxDestinationsPerUser: 10, dataDir: '/tmp' };
  const relay = new RelayManager({ store, vault, cfg, internalToken: 'T', log: quiet, fetchImpl: async () => ({ ok: true, json: async () => ({ items: [] }) }), spawn() { throw new Error('no'); } });
  const procs = [];
  const spawn = (bin, args) => { const p = new EventEmitter(); p.args = args; p.stdin = new PassThrough(); p.stderr = new EventEmitter(); p.chunks = []; p.stdin.on('data', (c) => p.chunks.push(c)); p.kill = () => p.emit('close', null, 'SIGKILL'); procs.push(p); return p; };
  const server = createApp({ cfg, store, relay, internalToken: 'T', processor: {}, player: {}, log: quiet, spawn });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); server.unref();
  return { store, user, uid, d1, d2, sid, server, relay, procs, port: server.address().port };
}

function connect(t, { origin, cookie } = {}) {
  return new Promise((resolve) => {
    const req = http.request({ port: t.port, host: '127.0.0.1', path: '/api/studio/ws', headers: {
      Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
      ...(origin === undefined ? { Origin: `http://127.0.0.1:${t.port}` } : origin ? { Origin: origin } : {}), ...(cookie ? { Cookie: cookie } : {}) } });
    req.on('upgrade', (res, socket) => {
      const msgs = [];
      const parser = { buf: Buffer.alloc(0) };
      socket.on('data', (c) => { // server frames are unmasked text
        parser.buf = Buffer.concat([parser.buf, c]);
        while (parser.buf.length >= 2) {
          const op = parser.buf[0] & 0xf; let len = parser.buf[1] & 0x7f; let off = 2;
          if (len === 126) { len = parser.buf.readUInt16BE(2); off = 4; }
          if (parser.buf.length < off + len) break;
          if (op === 1) msgs.push(JSON.parse(parser.buf.subarray(off, off + len).toString()));
          parser.buf = parser.buf.subarray(off + len);
        }
      });
      resolve({ status: 101, socket, msgs });
    });
    req.on('response', (res) => { resolve({ status: res.statusCode }); res.resume(); });
    req.on('error', () => resolve({ status: 0 }));
    req.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('studio websocket: auth + origin checks, streams chunks to ffmpeg, filters destinations, cleans up', async () => {
  const t = await boot();
  // find a valid session cookie
  const token = t.store.createSession(t.uid, 3600000);
  const cookie = `sid=${token}`;
  assert.equal((await connect(t, { cookie: '' })).status, 401, 'no login');
  assert.equal((await connect(t, { cookie, origin: 'https://evil.example' })).status, 403, 'other site');
  assert.equal((await connect(t, { cookie, origin: '' })).status, 403, 'no origin');

  const c = await connect(t, { cookie });
  assert.equal(c.status, 101);
  c.socket.write(maskedFrame(0x1, JSON.stringify({ type: 'start', audio: true, height: 720, dest_ids: [t.d1] })));
  await sleep(60);
  assert.deepEqual(c.msgs[0], { type: 'ready', height: 720 });
  assert.equal(t.procs.length, 1);
  assert.ok(t.procs[0].args.includes('rtmp://m:1935/live/' + t.user.ingest_key));
  assert.deepEqual([...t.relay.filters.get(t.user.ingest_key)], [t.d1], 'only the ticked destination');

  c.socket.write(maskedFrame(0x2, Buffer.alloc(100000, 3)));
  c.socket.write(maskedFrame(0x2, Buffer.alloc(10, 4)));
  await sleep(60);
  assert.equal(Buffer.concat(t.procs[0].chunks).length, 100010);

  // a second tab is refused
  const c2 = await connect(t, { cookie });
  c2.socket.write(maskedFrame(0x1, JSON.stringify({ type: 'start' })));
  await sleep(60);
  assert.match(c2.msgs[0].message, /already live/);

  c.socket.write(maskedFrame(0x1, JSON.stringify({ type: 'stop' })));
  await sleep(60);
  assert.equal(c.msgs.at(-1).type, 'ended');
  assert.equal(t.relay.filters.has(t.user.ingest_key), false);
  assert.ok(t.store.listActivity(t.uid).some((a) => a.action === 'studio_started'));
  assert.equal(t.server.studio.active.size, 0);
});

test('studio: refuses when already live from OBS, when no destination, and ends if ffmpeg dies', async () => {
  const t = await boot();
  const cookie = `sid=${t.store.createSession(t.uid, 3600000)}`;
  t.relay.liveKeys.add(t.user.ingest_key);
  let c = await connect(t, { cookie });
  c.socket.write(maskedFrame(0x1, JSON.stringify({ type: 'start' }))); await sleep(50);
  assert.match(c.msgs[0].message, /already live/);
  t.relay.liveKeys.clear();

  c = await connect(t, { cookie });
  c.socket.write(maskedFrame(0x1, JSON.stringify({ type: 'start', dest_ids: [9999] }))); await sleep(50);
  assert.match(c.msgs[0].message, /at least one/);

  c = await connect(t, { cookie });
  c.socket.write(maskedFrame(0x1, JSON.stringify({ type: 'start' }))); await sleep(50);
  assert.equal(c.msgs[0].type, 'ready');
  t.procs.at(-1).stderr.emit('data', Buffer.from('Connection refused\n'));
  t.procs.at(-1).emit('close', 1);
  await sleep(50);
  assert.match(c.msgs[1].message, /Connection refused/);
  assert.equal(c.msgs.at(-1).type, 'ended');
  assert.equal(t.server.studio.active.size, 0);

  t.store.updateDestination?.(t.d1, { enabled: false });
});
