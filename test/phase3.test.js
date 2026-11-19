import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { openDb } from '../src/db.js';
import { makeVault, hashPassword, sha256 } from '../src/crypto.js';
import { RelayManager, buildArgs } from '../src/relay.js';
import { Recorder, buildRecordArgs } from '../src/recorder.js';
import { SchedulePlayer } from '../src/player.js';
import { createApp } from '../src/server.js';
import { relayEventHandler, recorderEventHandler } from '../src/alerts.js';
import { VividStream, VividStreamError } from '../client/vivid-stream-client.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vs3-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = { error() {}, warn() {}, info() {} };

function fakeProc() {
  const p = new EventEmitter();
  p.stderr = new EventEmitter(); p.stdout = new EventEmitter();
  p.signals = [];
  p.kill = (sig) => { p.signals.push(sig); setImmediate(() => p.emit('close', null, sig)); };
  return p;
}

// ------------------------------------------------------------------ relay: stats, slow, ingest events
function relaySetup() {
  const store = openDb(':memory:');
  const vault = makeVault('s'.repeat(20));
  const uid = store.createUser({ email: 'a@x.com', name: 'Asha', passwordHash: 'h' });
  const user = store.getUser(uid);
  const dest = store.createDestination({ userId: uid, name: 'YT', platform: 'youtube', rtmpUrl: 'rtmp://a.example.com/x', keyEnc: vault.encrypt('KEYKEY1') });
  const live = new Set(); const procs = []; const events = [];
  const relay = new RelayManager({
    store, vault, cfg: { mediamtxApi: 'http://m', mediamtxRtmp: 'rtmp://m:1935', ffmpegBin: 'ffmpeg', pollMs: 1000, backoffBaseMs: 20, backoffMaxMs: 80, stableMs: 10, slowMs: 30 },
    internalToken: 'TOK1234', log: quiet, onEvent: (e) => events.push(e),
    fetchImpl: async () => ({ ok: true, json: async () => ({ items: [...live].map((k) => ({ name: `live/${k}`, ready: true })) }) }),
    spawn: () => { const p = fakeProc(); procs.push(p); return p; },
  });
  return { store, user, dest, live, procs, events, relay };
}

test('relay args ask ffmpeg for progress', () => {
  const a = buildArgs({ input: 'i', output: 'o' });
  assert.deepEqual(a.slice(a.indexOf('-progress'), a.indexOf('-progress') + 2), ['-progress', 'pipe:1']);
  assert.ok(a.includes('-nostats'));
});

test('relay: bitrate/speed parsed from progress, slow destination raises one event', async () => {
  const t = relaySetup();
  t.live.add(t.user.ingest_key);
  await t.relay.tick();
  await sleep(30);
  const p = t.procs[0];
  p.stdout.emit('data', Buffer.from('bitrate=5972.1kbits/s\nspeed=1.00x\nprogress=continue\n'));
  const s = t.relay.statusFor(t.dest);
  assert.equal(s.status, 'live');
  assert.equal(Math.round(s.stats.bitrateKbps), 5972);
  assert.equal(s.stats.speed, 1);

  // chunks may split lines
  p.stdout.emit('data', Buffer.from('bitrate=4000.0kb'));
  p.stdout.emit('data', Buffer.from('its/s\nspeed=0.50x\nprogress=continue\n'));
  assert.equal(t.relay.statusFor(t.dest).stats.speed, 0.5);
  assert.ok(!t.events.some((e) => e.type === 'slow'), 'not yet: needs to stay slow for a while');
  await sleep(45);
  p.stdout.emit('data', Buffer.from('speed=0.50x\nprogress=continue\n'));
  p.stdout.emit('data', Buffer.from('speed=0.50x\nprogress=continue\n'));
  assert.equal(t.events.filter((e) => e.type === 'slow').length, 1, 'reported once');
  p.stdout.emit('data', Buffer.from('speed=1.00x\nprogress=continue\n'));
  await t.relay.shutdown();
});

test('relay: OBS start / drop events, but not for scheduled videos or expected drops', async () => {
  const t = relaySetup();
  t.live.add(t.user.ingest_key);
  await t.relay.tick();
  assert.deepEqual(t.events.filter((e) => e.type.startsWith('ingest')).map((e) => e.type), ['ingest_started']);
  assert.equal(t.events[0].detail, '1');
  t.live.clear();
  await t.relay.tick();
  assert.deepEqual(t.events.filter((e) => e.type.startsWith('ingest')).map((e) => e.type), ['ingest_started', 'ingest_dropped']);

  // scheduled video: filter set -> no "OBS started"; expected drop -> no "dropped"
  const t2 = relaySetup();
  t2.relay.setFilter(t2.user.ingest_key, [t2.dest]);
  t2.live.add(t2.user.ingest_key);
  await t2.relay.tick();
  t2.relay.noteExpectedDrop(t2.user.ingest_key);
  t2.relay.setFilter(t2.user.ingest_key, null);
  t2.live.clear();
  await t2.relay.tick();
  assert.equal(t2.events.filter((e) => e.type.startsWith('ingest')).length, 0);
  await t.relay.shutdown(); await t2.relay.shutdown();
});

test('alerts: OBS dropped and slow produce WhatsApp texts', () => {
  const store = openDb(':memory:');
  const uid = store.createUser({ email: 'a@x.com', name: 'Asha', passwordHash: 'h' });
  const sent = [];
  const h = relayEventHandler({ store, notifier: { send: async (u, m, o) => { sent.push([m, o?.key]); } } });
  h({ type: 'ingest_dropped', userId: uid, name: 'Asha' });
  h({ type: 'slow', userId: uid, name: 'YT', destId: 3, detail: '0.40x' });
  h({ type: 'ingest_started', userId: uid, name: 'Asha', detail: '2' });
  assert.equal(sent.length, 3);
  assert.match(sent[0][0], /कट गई/);
  assert.match(sent[1][0], /0.40x/);
  recorderEventHandler({ store })({ type: 'record_saved', userId: uid, detail: 'x' });
  assert.ok(store.listActivity(uid).some((a) => a.action === 'recording_saved'));
});

// ------------------------------------------------------------------ recorder
function recSetup({ free = 50 * 1024 ** 3 } = {}) {
  const dir = tmp();
  const store = openDb(':memory:');
  const uid = store.createUser({ email: 'a@x.com', name: 'A', passwordHash: 'h' });
  store.updateUser(uid, { record: true });
  const user = store.getUser(uid);
  const relay = { liveKeys: new Set(), filters: new Map() };
  const procs = []; const events = []; let nowMs = 1_800_000_000_000;
  const rec = new Recorder({
    store, relay, internalToken: 'TOK', log: quiet, onEvent: (e) => events.push(e), now: () => nowMs, freeBytes: () => free,
    cfg: { dataDir: dir, mediamtxRtmp: 'rtmp://m:1935', ffmpegBin: 'ffmpeg', diskReserveBytes: 1024 ** 3, recordingMaxHours: 6, recordingKeepDays: 7 },
    spawn: (bin, args) => { const p = fakeProc(); p.args = args; procs.push(p); return p; },
  });
  return { dir, store, uid, user, relay, procs, events, rec, advance: (ms) => { nowMs += ms; } };
}

test('recorder: records while live, stops when the stream ends, keeps real files only', async () => {
  const t = recSetup();
  t.rec.tick();
  assert.equal(t.procs.length, 0, 'nothing live');
  t.relay.liveKeys.add(t.user.ingest_key);
  t.rec.tick();
  assert.equal(t.procs.length, 1);
  assert.ok(t.procs[0].args.includes('matroska'));
  assert.ok(t.procs[0].args.some((a) => a.includes(`live/${t.user.ingest_key}?token=TOK`)));
  assert.equal(t.procs[0].args[t.procs[0].args.indexOf('-t') + 1], String(6 * 3600));
  t.rec.tick();
  assert.equal(t.procs.length, 1, 'only one recording per user');

  const out = t.procs[0].args.at(-1);
  fs.writeFileSync(out, Buffer.alloc(3 * 1024 * 1024, 1));
  t.relay.liveKeys.clear();
  t.rec.tick();
  assert.deepEqual(t.procs[0].signals, ['SIGINT']);
  await sleep(10);
  const [r] = t.store.listRecordings(t.uid);
  assert.equal(r.status, 'done');
  assert.equal(r.size, 3 * 1024 * 1024);
  assert.ok(t.events.some((e) => e.type === 'record_saved'));
  assert.equal(t.store.storageUsed(t.uid), 3 * 1024 * 1024, 'recordings count toward the quota');

  // blip: tiny file is discarded
  t.advance(60000);
  t.relay.liveKeys.add(t.user.ingest_key);
  t.rec.tick();
  fs.writeFileSync(t.procs[1].args.at(-1), 'x');
  t.relay.liveKeys.clear(); t.rec.tick(); await sleep(10);
  assert.equal(t.store.listRecordings(t.uid).length, 1);
});

test('recorder: respects the toggle, scheduled videos, low disk, retention', async () => {
  let t = recSetup();
  t.store.updateUser(t.uid, { record: false });
  t.relay.liveKeys.add(t.user.ingest_key); t.rec.tick();
  assert.equal(t.procs.length, 0, 'toggle off');

  t = recSetup();
  t.relay.filters.set(t.user.ingest_key, new Set([1]));
  t.relay.liveKeys.add(t.user.ingest_key); t.rec.tick();
  assert.equal(t.procs.length, 0, 'scheduled video is not recorded again');

  t = recSetup({ free: 1.5 * 1024 ** 3 });
  t.relay.liveKeys.add(t.user.ingest_key); t.rec.tick();
  assert.equal(t.procs.length, 0, 'low disk');
  assert.ok(t.events.some((e) => e.type === 'record_skipped'));

  t = recSetup();
  const f = path.join(t.dir, 'old.mkv'); fs.writeFileSync(f, Buffer.alloc(2 * 1024 * 1024));
  const id = t.store.createRecording({ userId: t.uid, title: 'old', filePath: f, startedAt: 1 });
  t.store.updateRecording(id, { size: 2 * 1024 * 1024, status: 'done', endedAt: 1_800_000_000_000 - 8 * 86400_000 });
  const f2 = path.join(t.dir, 'new.mkv'); fs.writeFileSync(f2, Buffer.alloc(2 * 1024 * 1024));
  const id2 = t.store.createRecording({ userId: t.uid, title: 'new', filePath: f2, startedAt: 1 });
  t.store.updateRecording(id2, { size: 2 * 1024 * 1024, status: 'done', endedAt: 1_800_000_000_000 - 86400_000 });
  t.rec.purgeOld();
  assert.equal(t.store.getRecording(id), undefined);
  assert.ok(!fs.existsSync(f));
  assert.ok(t.store.getRecording(id2) && fs.existsSync(f2));

  // restart: an open recording is finalised
  const f3 = path.join(t.dir, 'open.mkv'); fs.writeFileSync(f3, Buffer.alloc(2 * 1024 * 1024));
  const id3 = t.store.createRecording({ userId: t.uid, title: 'open', filePath: f3, startedAt: 1 });
  t.rec.start(); t.rec.shutdown();
  assert.equal(t.store.getRecording(id3).status, 'done');
  assert.equal(buildRecordArgs({ input: 'i', output: 'o', maxSeconds: 5 }).at(-1), 'o');
});

// ------------------------------------------------------------------ API: keys, password, recordings, client
async function boot() {
  const dataDir = tmp();
  const cfg = {
    dataDir, mediamtxApi: 'http://m', mediamtxRtmp: 'rtmp://m:1935', publicRtmpUrl: 'rtmp://r.example.com/live', ffmpegBin: 'ffmpeg',
    ffprobeBin: 'ffprobe', pollMs: 1000, backoffBaseMs: 20, backoffMaxMs: 80, stableMs: 30, maxDestinationsPerUser: 10,
    maxUploadBytes: 50_000_000, userQuotaBytes: 80_000_000, diskReserveBytes: 0, lateStartMs: 600000, schedulePollMs: 100000,
    alertUrl: '', recordingKeepDays: 7,
  };
  const store = openDb(':memory:');
  const vault = makeVault('s'.repeat(20));
  const uid = store.createUser({ email: 'op@x.com', name: 'Op', passwordHash: hashPassword('operpass1'), role: 'operator' });
  const adminId = store.createUser({ email: 'ad@x.com', name: 'Ad', passwordHash: hashPassword('adminpass1'), role: 'admin' });
  store.createDestination({ userId: uid, name: 'YT', platform: 'youtube', rtmpUrl: 'rtmp://a.example.com/x', keyEnc: vault.encrypt('kkkk1') });
  const relay = new RelayManager({ store, vault, cfg, internalToken: 'T', fetchImpl: async () => ({ ok: true, json: async () => ({ items: [] }) }), spawn() { throw new Error('no'); }, log: quiet });
  const enqueued = [];
  const processor = { enqueue: (id) => { enqueued.push(id); store.updateVideo(id, { status: 'ready', duration: 12, width: 1280, height: 720, fps: 30 }); } };
  const player = new SchedulePlayer({ store, cfg, relay, notifier: null, dataDir, log: quiet, spawn: () => fakeProc() });
  const server = createApp({ cfg, store, relay, internalToken: 'T', processor, player, log: quiet });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  server.unref();
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookieClient = async (email, password) => {
    let cookie = '';
    const call = async (method, p, body, headers = {}) => {
      const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-requested-with': 'vivid', cookie, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
      const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
      const buf = Buffer.from(await res.arrayBuffer()); let json = null; try { json = JSON.parse(buf.toString()); } catch { /* */ }
      return { status: res.status, json, buf, headers: res.headers };
    };
    await call('POST', '/api/login', { email, password });
    return call;
  };
  return { store, cfg, uid, adminId, base, enqueued, cookieClient, dataDir };
}

test('API keys: create once, Bearer auth works without CSRF header, limited powers, revoke', async () => {
  const t = await boot();
  const op = await t.cookieClient('op@x.com', 'operpass1');
  const created = await op('POST', '/api/keys', { name: 'Vividora' });
  assert.equal(created.status, 201);
  const token = created.json.token;
  assert.match(token, /^vs_[0-9a-f]{40}$/);
  const list = await op('GET', '/api/keys');
  assert.equal(list.json.keys.length, 1);
  assert.ok(!JSON.stringify(list.json).includes(token), 'token is never shown again');
  assert.ok(![...t.store.raw.prepare('SELECT token_hash FROM api_keys').all()].some((r) => r.token_hash === token), 'only a hash is stored');

  const bearer = (method, p, body) => fetch(t.base + p, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  assert.equal((await bearer('GET', '/api/status')).status, 200);
  assert.equal((await bearer('POST', '/api/destinations', { name: 'n', rtmp_url: 'rtmp://b.example.com/x', stream_key: 'kkkk2' })).status, 201, 'no CSRF header needed with a key');
  for (const [m, p, b] of [['POST', '/api/keys', { name: 'x' }], ['GET', '/api/keys'], ['POST', '/api/me/password', { current: 'a', new: 'bbbbbbbb' }],
    ['POST', '/api/me/rotate-ingest-key'], ['GET', '/api/users']]) {
    assert.equal((await bearer(m, p, b)).status, 403, `${m} ${p}`);
  }
  const bad = await fetch(t.base + '/api/status', { headers: { authorization: 'Bearer vs_' + '0'.repeat(40) } });
  assert.equal(bad.status, 401);
  // a cookie session still needs the CSRF header
  const noHeader = await fetch(t.base + '/api/keys', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(noHeader.status, 403);

  assert.equal((await op('DELETE', `/api/keys/${list.json.keys[0].id}`)).status, 200);
  assert.equal((await bearer('GET', '/api/status')).status, 401, 'revoked');
  // deactivated users lose their keys' access
  const c2 = (await op('POST', '/api/keys', { name: 'again' })).json.token;
  t.store.updateUser(t.uid, { active: false });
  assert.equal((await fetch(t.base + '/api/status', { headers: { authorization: `Bearer ${c2}` } })).status, 401);
});

test('password change: checks current password, signs out other sessions, new login works', async () => {
  const t = await boot();
  const a = await t.cookieClient('op@x.com', 'operpass1');
  const b = await t.cookieClient('op@x.com', 'operpass1');
  assert.equal((await a('POST', '/api/me/password', { current: 'wrong', new: 'newpassword1' })).status, 400);
  assert.equal((await a('POST', '/api/me/password', { current: 'operpass1', new: 'short' })).status, 400);
  assert.equal((await a('POST', '/api/me/password', { current: 'operpass1', new: 'newpassword1' })).status, 200);
  assert.equal((await a('GET', '/api/me')).status, 200, 'this device stays signed in');
  assert.equal((await b('GET', '/api/me')).status, 401, 'other device signed out');
  const again = await cookieLogin(t, 'op@x.com', 'newpassword1');
  assert.equal(again, 200);
  assert.equal(await cookieLogin(t, 'op@x.com', 'operpass1'), 401);
});
async function cookieLogin(t, email, password) {
  const r = await fetch(t.base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'vivid' }, body: JSON.stringify({ email, password }) });
  return r.status;
}

test('recording toggle + recordings: list, ranged download, to-video, delete, ownership', async () => {
  const t = await boot();
  const op = await t.cookieClient('op@x.com', 'operpass1');
  const ad = await t.cookieClient('ad@x.com', 'adminpass1');
  assert.equal((await op('PATCH', '/api/me', { record: true })).status, 200);
  assert.equal((await op('GET', '/api/me/settings')).json.record, true);
  assert.equal(t.store.getUser(t.uid).record, 1);

  const f = path.join(t.dataDir, 'rec1.mkv');
  const data = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251));
  fs.writeFileSync(f, data);
  const id = t.store.createRecording({ userId: t.uid, title: 'Live 1', filePath: f, startedAt: 1 });
  t.store.updateRecording(id, { size: data.length, status: 'done', endedAt: 2 });
  const open = t.store.createRecording({ userId: t.uid, title: 'running', filePath: f + 'x', startedAt: 1 });

  assert.equal((await op('GET', '/api/recordings')).json.recordings.length, 2);
  const full = await op('GET', `/api/recordings/${id}/download`);
  assert.equal(full.status, 200);
  assert.deepEqual(full.buf, data);
  assert.match(full.headers.get('content-disposition'), /attachment/);
  const part = await op('GET', `/api/recordings/${id}/download`, undefined, { range: 'bytes=100-199' });
  assert.equal(part.status, 206);
  assert.deepEqual(part.buf, data.subarray(100, 200));
  assert.equal(part.headers.get('content-range'), `bytes 100-199/${data.length}`);
  assert.equal((await op('GET', `/api/recordings/${id}/download`, undefined, { range: 'bytes=9000-' })).status, 416);
  assert.equal((await op('DELETE', `/api/recordings/${open}`)).status, 409, 'cannot delete while recording');

  const other = await t.cookieClient('ad@x.com', 'adminpass1');
  assert.equal((await other('GET', `/api/recordings/${id}/download`)).status, 200, 'admin can see all');
  t.store.createUser({ email: 'o3@x.com', name: 'O3', passwordHash: hashPassword('operpass3'), role: 'operator' });
  const o3 = await t.cookieClient('o3@x.com', 'operpass3');
  assert.equal((await o3('GET', `/api/recordings/${id}/download`)).status, 404);
  assert.equal((await o3('POST', `/api/recordings/${id}/to-video`)).status, 404);

  const conv = await op('POST', `/api/recordings/${id}/to-video`);
  assert.equal(conv.status, 200);
  const v = t.store.getVideo(conv.json.video_id);
  assert.equal(v.title, 'Live 1');
  assert.ok(fs.existsSync(v.file_path) && v.file_path.endsWith('.mkv') && !fs.existsSync(f));
  assert.equal(t.store.getRecording(id), undefined);
  assert.deepEqual(t.enqueued, [v.id]);
  assert.ok(ad);
});

test('Vividora client: upload in chunks (with a flaky network), wait until ready, schedule, cancel', async () => {
  const t = await boot();
  const op = await t.cookieClient('op@x.com', 'operpass1');
  const token = (await op('POST', '/api/keys', { name: 'client' })).json.token;
  const file = path.join(t.dataDir, 'final cut.mp4');
  const data = Buffer.alloc(20 * 1024 * 1024 + 123, 9); // 3 chunks of 8 MB
  fs.writeFileSync(file, data);

  let puts = 0;
  const flaky = async (url, opts) => {
    if (opts?.method === 'PUT' && ++puts === 2) throw new TypeError('fetch failed'); // network drop on 2nd chunk
    return fetch(url, opts);
  };
  const vs = new VividStream({ baseUrl: t.base, apiKey: token, fetchImpl: flaky });
  const progress = [];
  const video = await vs.uploadVideo(file, { title: 'Morning bulletin', onProgress: (p) => progress.push(p), pollMs: 10 });
  assert.equal(video.status, 'ready');
  assert.equal(video.title, 'Morning bulletin');
  assert.ok(progress.length >= 3 && progress.at(-1) === 1);
  assert.deepEqual(fs.readFileSync(t.store.getVideo(video.id).file_path), data, 'file arrived intact despite the drop');

  const dests = await vs.destinations();
  assert.equal(dests.length, 1);
  const s = await vs.scheduleLive({ videoIds: [video.id], startAt: new Date(Date.now() + 3600_000), destIds: [dests[0].id] });
  assert.equal(s.status, 'scheduled');
  await assert.rejects(() => vs.scheduleLive({ videoIds: [video.id], startAt: Date.now() + 3600_000 + 1000 }), (e) => e instanceof VividStreamError && e.status === 409);
  await assert.rejects(() => vs.scheduleLive({ videoIds: [999], startAt: Date.now() + 9e6 }), (e) => e.status === 400);
  await vs.cancelSchedule(s.id);
  assert.equal((await vs.schedules())[0].status, 'cancelled');
  await vs.deleteVideo(video.id);
  assert.equal((await vs.videos()).length, 0);
  assert.throws(() => new VividStream({ baseUrl: '' }));
  await assert.rejects(() => new VividStream({ baseUrl: t.base, apiKey: 'vs_' + 'a'.repeat(40) }).status(), (e) => e.status === 401);
});

test('Vividora client rejects unsupported files', async () => {
  const t = await boot();
  const token = (await (await t.cookieClient('op@x.com', 'operpass1'))('POST', '/api/keys', { name: 'c' })).json.token;
  const f = path.join(t.dataDir, 'x.exe'); fs.writeFileSync(f, 'abc');
  await assert.rejects(() => new VividStream({ baseUrl: t.base, apiKey: token }).uploadVideo(f), (e) => e.status === 400);
  assert.equal(sha256('a').length, 64);
});
