import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { openDb } from '../src/db.js';
import { makeVault, hashPassword } from '../src/crypto.js';
import { createApp } from '../src/server.js';
import { RelayManager } from '../src/relay.js';

function masked(payload) {
  const body = Buffer.from(payload); const mask = crypto.randomBytes(4);
  const head = body.length < 126 ? Buffer.from([0x81, 0x80 | body.length]) : (() => { const h = Buffer.alloc(4); h[0] = 0x81; h[1] = 0x80 | 126; h.writeUInt16BE(body.length, 2); return h; })();
  const m = Buffer.from(body); for (let i = 0; i < m.length; i++) m[i] ^= mask[i & 3];
  return Buffer.concat([head, mask, m]);
}
async function boot() {
  const store = openDb(':memory:');
  const vault = makeVault('s'.repeat(20));
  const uid = store.createUser({ email: 'a@x.com', name: 'A', passwordHash: hashPassword('pass12345') });
  const other = store.createUser({ email: 'b@x.com', name: 'B', passwordHash: hashPassword('pass12345') });
  const cfg = { mediamtxApi: 'http://m', mediamtxRtmp: 'rtmp://m', publicRtmpUrl: 'rtmp://r', ffmpegBin: 'ffmpeg', pollMs: 1000, backoffBaseMs: 20, backoffMaxMs: 80, stableMs: 30, maxDestinationsPerUser: 5, dataDir: '/tmp' };
  const relay = new RelayManager({ store, vault, cfg, internalToken: 'T', log: { error() {}, warn() {}, info() {} }, fetchImpl: async () => ({ ok: true, json: async () => ({ items: [] }) }), spawn() { throw new Error('x'); } });
  const server = createApp({ cfg, store, relay, internalToken: 'T', processor: {}, player: {}, log: { error() {}, warn() {}, info() {} } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); server.unref();
  return { store, uid, other, server, port: server.address().port, cookie: (id) => `sid=${store.createSession(id, 3600000)}` };
}
const all = [];
function ws(t, path, { cookie, origin = `http://127.0.0.1:${t.port}` } = {}) {
  return new Promise((resolve) => {
    const req = http.request({ port: t.port, host: '127.0.0.1', path, headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), ...(origin ? { Origin: origin } : {}), ...(cookie ? { Cookie: cookie } : {}) } });
    req.on('upgrade', (res, socket, head) => {
      const msgs = []; let buf = Buffer.alloc(0);
      const onData = (c) => { buf = Buffer.concat([buf, c]); while (buf.length >= 2) { const op = buf[0] & 15; let len = buf[1] & 127; let off = 2; if (len === 126) { len = buf.readUInt16BE(2); off = 4; } if (buf.length < off + len) break; if (op === 1) msgs.push(JSON.parse(buf.subarray(off, off + len))); buf = buf.subarray(off + len); } };
      socket.on('data', onData); if (head?.length) onData(head);
      socket.on('error', () => {}); all.push(socket);
      resolve({ status: 101, socket, msgs, send: (o) => socket.write(masked(JSON.stringify(o))) });
    });
    req.on('response', (res) => { resolve({ status: res.statusCode }); res.resume(); });
    req.on('error', () => resolve({ status: 0 }));
    req.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const invite = async (t, cookie) => (await (await fetch(`http://127.0.0.1:${t.port}/api/studio/invite`, { method: 'POST', headers: { cookie, 'x-requested-with': 'vivid' } })).json());

test('guests: invite needs login, host and guest signalling flows, limits', async () => {
  const t = await boot();
  const cookie = t.cookie(t.uid);
  assert.equal((await fetch(`http://127.0.0.1:${t.port}/api/studio/invite`, { method: 'POST', headers: { 'x-requested-with': 'vivid' } })).status, 401);
  const inv = await invite(t, cookie);
  assert.match(inv.url, /^\/join\.html#[0-9a-f]{24}$/);
  assert.equal((await invite(t, cookie)).token, inv.token, 'one invite per user');
  const tk = inv.token;

  assert.equal((await ws(t, `/api/guest/join?token=${tk}&name=Ravi`)).status, 409, 'host not in studio yet');
  assert.equal((await ws(t, `/api/guest/host?token=${tk}`, { cookie: t.cookie(t.other) })).status, 401, 'other user cannot host this room');
  assert.equal((await ws(t, `/api/guest/host?token=${tk}`, { cookie, origin: 'https://evil.example' })).status, 403);
  assert.equal((await ws(t, `/api/guest/host?token=nope`, { cookie })).status, 404);

  const host = await ws(t, `/api/guest/host?token=${tk}`, { cookie });
  assert.equal(host.status, 101);
  await sleep(30); assert.equal(host.msgs[0].type, 'host-ready');

  const g1 = await ws(t, `/api/guest/join?token=${tk}&name=Ravi`);
  assert.equal(g1.status, 101);
  await sleep(40);
  assert.deepEqual(g1.msgs[0], { type: 'welcome', id: 1, name: 'Ravi' });
  assert.deepEqual(host.msgs.at(-1), { type: 'guest-joined', id: 1, name: 'Ravi' });

  g1.send({ signal: { sdp: { type: 'offer', sdp: 'v=0' } } });
  await sleep(40);
  assert.deepEqual(host.msgs.at(-1), { type: 'signal', from: 1, signal: { sdp: { type: 'offer', sdp: 'v=0' } } });
  host.send({ to: 1, signal: { sdp: { type: 'answer', sdp: 'v=0' } } });
  await sleep(40);
  assert.equal(g1.msgs.at(-1).type, 'signal');

  for (const n of ['B', 'C', 'D', 'E', 'F', 'G', 'H']) await ws(t, `/api/guest/join?token=${tk}&name=${n}`);
  assert.equal((await ws(t, `/api/guest/join?token=${tk}&name=I`)).status, 429, 'max 8 guests');

  host.send({ type: 'kick', to: 1 });
  await sleep(40);
  assert.equal(g1.msgs.at(-1).type, 'kicked');
  assert.equal(host.msgs.some((m) => m.type === 'guest-left' && m.id === 1), true);

  const other = await ws(t, '/api/nothing'); assert.ok([404, 0].includes(other.status));
  host.socket.destroy(); await sleep(200);
  assert.equal(t.server.guests.rooms.get(tk).host, null);
  assert.equal((await ws(t, `/api/guest/join?token=${tk}&name=E`)).status, 409, 'closed studio refuses guests');
  for (const s of all) s.destroy();
});
