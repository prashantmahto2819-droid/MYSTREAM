import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.js';
import { makeVault, hashPassword } from '../src/crypto.js';
import { RelayManager } from '../src/relay.js';
import { Notifier, renderTemplate } from '../src/notify.js';
import { probeVideo, needsConvert, VideoProcessor } from '../src/media.js';
import { SchedulePlayer, buildConcatList, buildPlayArgs } from '../src/player.js';
import { createApp } from '../src/server.js';
import { playerEventHandler } from '../src/alerts.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vs-test-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quietLog = { error() {}, warn() {}, info() {} };

function mkClip(file, { secs = 2, gop = 48, audio = true, vcodec = 'libx264', size = '320x240', fps = 24 } = {}) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=${fps}`];
  if (audio) args.push('-f', 'lavfi', '-i', 'sine=frequency=440');
  args.push('-t', String(secs), '-c:v', vcodec, '-pix_fmt', 'yuv420p');
  if (vcodec === 'libx264') args.push('-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0', '-preset', 'ultrafast');
  if (audio) args.push('-c:a', 'aac'); else args.push('-an');
  args.push(file);
  const r = spawnSync('ffmpeg', args);
  assert.equal(r.status, 0, String(r.stderr));
}

// ---------------------------------------------------------------- notifier
test('notifier: template cannot break JSON, cooldown, user phone + office numbers', async () => {
  const body = renderTemplate('{"to":"{{to}}","message":"{{message}}","x":{"y":["{{to}}"]}}', { to: '9198', message: 'hi "quote" \n {{to}}' });
  assert.equal(body.message, 'hi "quote" \n {{to}}'.replace('{{to}}', '{{to}}'));
  assert.deepEqual(body.x.y, ['9198']);

  const store = openDb(':memory:');
  const uid = store.createUser({ email: 'a@x.com', name: 'A', passwordHash: 'h' });
  store.updateUser(uid, { phone: '911111111111' });
  const calls = [];
  let t = 1000;
  const n = new Notifier({
    cfg: { alertUrl: 'http://hook', alertAuth: 'Bearer T', alertBodyTemplate: '{"to":"{{to}}","message":"{{message}}"}', alertTo: ['922222222222'], alertCooldownMs: 5000 },
    store, now: () => t, log: quietLog,
    fetchImpl: async (url, opts) => { calls.push({ url, opts, body: JSON.parse(opts.body) }); return { ok: true }; },
  });
  const r = await n.send(uid, 'hello', { key: 'k' });
  assert.equal(r.sent, 2);
  assert.deepEqual(calls.map((c) => c.body.to).sort(), ['911111111111', '922222222222']);
  assert.equal(calls[0].opts.headers.authorization, 'Bearer T');
  assert.equal((await n.send(uid, 'hello again', { key: 'k' })).skipped, 'cooldown');
  t += 6000;
  assert.equal((await n.send(uid, 'later', { key: 'k' })).sent, 2);

  const off = new Notifier({ cfg: { alertUrl: '', alertTo: [] }, store, log: quietLog });
  assert.equal((await off.send(uid, 'x')).skipped, 'not configured');
});

// ---------------------------------------------------------------- media (real ffmpeg)
test('media: probe, convert only when needed, add silent audio', { skip: !hasFfmpeg, timeout: 120000 }, async () => {
  const dir = tmp();
  const good = path.join(dir, 'good.mp4');
  const bad = path.join(dir, 'bad.mkv');
  const noAudio = path.join(dir, 'noaudio.mp4');
  mkClip(good, { secs: 3, gop: 48 });
  mkClip(bad, { secs: 3, vcodec: 'mpeg4' });
  mkClip(noAudio, { secs: 3, gop: 48, audio: false });

  const g = await probeVideo('ffprobe', good);
  assert.equal(g.vcodec, 'h264');
  assert.equal(g.acodec, 'aac');
  assert.equal(g.width, 320);
  assert.ok(g.maxKeyGap <= 2.5);
  assert.equal(needsConvert(g), false);
  assert.equal(needsConvert(await probeVideo('ffprobe', bad)), true);
  assert.equal(needsConvert(await probeVideo('ffprobe', noAudio)), true, 'no audio track must be fixed');

  const store = openDb(':memory:');
  const uid = store.createUser({ email: 'a@x.com', name: 'A', passwordHash: 'h' });
  const cfg = { ffmpegBin: 'ffmpeg', ffprobeBin: 'ffprobe' };
  const proc = new VideoProcessor({ store, cfg, log: quietLog });
  const add = (file, ext) => {
    const id = store.createVideo({ userId: uid, title: 'v', filePath: file, ext, expectedSize: fs.statSync(file).size });
    store.updateVideo(id, { status: 'processing', size: fs.statSync(file).size });
    return id;
  };
  const idGood = add(good, 'mp4');
  const idBad = add(bad, 'mkv');
  const idNo = add(noAudio, 'mp4');
  for (const id of [idGood, idBad, idNo]) await proc.process(id);

  const vg = store.getVideo(idGood);
  assert.equal(vg.status, 'ready');
  assert.equal(vg.file_path, good, 'already-compatible file is left untouched');
  const vb = store.getVideo(idBad);
  assert.equal(vb.status, 'ready');
  assert.ok(vb.file_path.endsWith('.mp4'));
  assert.ok(!fs.existsSync(bad), 'original removed after conversion');
  const pb = await probeVideo('ffprobe', vb.file_path);
  assert.equal(pb.vcodec, 'h264');
  assert.equal(pb.acodec, 'aac');
  assert.ok(pb.maxKeyGap <= 2.5);
  const pn = await probeVideo('ffprobe', store.getVideo(idNo).file_path);
  assert.equal(pn.acodec, 'aac');

  fs.writeFileSync(path.join(dir, 'broken.mp4'), 'not a video');
  const idBroken = add(path.join(dir, 'broken.mp4'), 'mp4');
  await proc.process(idBroken);
  assert.equal(store.getVideo(idBroken).status, 'failed');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- player: real concat in copy mode
test('player: concat list quoting', () => {
  const l = buildConcatList(["/d/it's.mp4", '/d/b.mp4'], 2);
  assert.equal(l.trim().split('\n').length, 4);
  assert.ok(l.includes("it'\\''s.mp4"));
  assert.ok(buildPlayArgs({ listFile: 'l', output: 'o', infinite: true }).includes('-stream_loop'));
  assert.ok(!buildPlayArgs({ listFile: 'l', output: 'o', infinite: false }).includes('-stream_loop'));
});

test('player: two files play back-to-back in one copy-mode process; infinite loop keeps going', { skip: !hasFfmpeg, timeout: 60000 }, async () => {
  const dir = tmp();
  const a = path.join(dir, 'a.mp4'); const b = path.join(dir, 'b.mp4');
  mkClip(a, { secs: 2 }); mkClip(b, { secs: 2 });
  const list = path.join(dir, 'list.txt');
  fs.writeFileSync(list, buildConcatList([a, b], 1));
  const out = path.join(dir, 'out.flv');
  const r = spawnSync('ffmpeg', buildPlayArgs({ listFile: list, output: out, infinite: false }), { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const dur = Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out], { encoding: 'utf8' }).stdout);
  assert.ok(dur > 3.5 && dur < 4.6, `duration ${dur}`);
  const codec = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', out], { encoding: 'utf8' }).stdout;
  assert.match(codec, /h264/);

  // infinite: runs longer than one pass of the list until stopped
  fs.writeFileSync(list, buildConcatList([a], 0));
  const out2 = path.join(dir, 'out2.flv');
  const p = spawn('ffmpeg', buildPlayArgs({ listFile: list, output: out2, infinite: true }), { stdio: 'ignore' });
  await sleep(4500);
  p.kill('SIGINT');
  await new Promise((res) => p.on('close', res));
  const dur2 = Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out2], { encoding: 'utf8' }).stdout);
  assert.ok(dur2 > 2.6, `looped duration ${dur2}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- player logic (fake ffmpeg)
function playerSetup({ ingestLive = false } = {}) {
  const dir = tmp();
  const store = openDb(':memory:');
  const uid = store.createUser({ email: 'a@x.com', name: 'A', passwordHash: 'h' });
  const user = store.getUser(uid);
  const vault = makeVault('s'.repeat(20));
  const dest = store.createDestination({ userId: uid, name: 'YT', platform: 'youtube', rtmpUrl: 'rtmp://a.example.com/x', keyEnc: vault.encrypt('k1234') });
  const mkVideo = (title) => {
    const f = path.join(dir, `${title}.mp4`); fs.writeFileSync(f, 'x');
    const id = store.createVideo({ userId: uid, title, filePath: f, ext: 'mp4', expectedSize: 1 });
    store.updateVideo(id, { status: 'ready', duration: 10, width: 320, height: 240, fps: 24 });
    return id;
  };
  const filters = []; const procs = []; const events = [];
  const relay = { isIngestLive: () => ingestLive, setFilter: (k, v) => filters.push([k, v && [...v]]) };
  const spawnFake = (bin, args) => {
    const p = new EventEmitter(); p.args = args; p.stderr = new EventEmitter();
    p.kill = (sig) => setImmediate(() => p.emit('close', null, sig));
    procs.push(p); return p;
  };
  let nowMs = 1_000_000;
  const player = new SchedulePlayer({
    store, cfg: { ffmpegBin: 'ffmpeg', mediamtxRtmp: 'rtmp://mtx:1935', lateStartMs: 600000, schedulePollMs: 100000 },
    relay, notifier: null, spawn: spawnFake, now: () => nowMs, log: quietLog, dataDir: dir, onEvent: (e) => events.push(e),
  });
  return { dir, store, user, uid, dest, mkVideo, filters, procs, events, player, setNow: (n) => { nowMs = n; }, nowMs: () => nowMs };
}

test('player: starts on time, deletes video afterwards unless another schedule needs it', async () => {
  const t = playerSetup();
  const v1 = t.mkVideo('one'); const v2 = t.mkVideo('two');
  const s1 = t.store.createSchedule({ userId: t.uid, title: 'Morning', videoIds: [v1, v2], startAt: t.nowMs() + 1000, loopCount: 1, destIds: null, deleteAfter: true });
  t.store.createSchedule({ userId: t.uid, title: 'Evening', videoIds: [v2], startAt: t.nowMs() + 99999, loopCount: 1, destIds: null, deleteAfter: true });

  t.player.tick();
  assert.equal(t.procs.length, 0, 'not due yet');
  t.setNow(t.nowMs() + 2000);
  t.player.tick();
  assert.equal(t.procs.length, 1);
  assert.equal(t.store.getSchedule(s1).status, 'running');
  assert.ok(t.procs[0].args.includes('rtmp://mtx:1935/live/' + t.user.ingest_key));
  assert.deepEqual(t.filters[0], [t.user.ingest_key, [t.dest]]);
  assert.ok(t.events.some((e) => e.type === 'started' && e.destinations === 1));

  t.procs[0].emit('close', 0, null);
  assert.equal(t.store.getSchedule(s1).status, 'done');
  assert.equal(t.filters.at(-1)[1], null, 'destination filter released');
  assert.equal(t.store.getVideo(v1), undefined, 'v1 auto-deleted');
  assert.ok(t.store.getVideo(v2), 'v2 kept: still needed by the evening schedule');
  assert.ok(!fs.existsSync(path.join(t.dir, 'tmp', `schedule-${s1}.txt`)));
  assert.ok(t.events.some((e) => e.type === 'video_deleted'));
});

test('player: failure, missed start, OBS conflict, cancel, restart recovery', async () => {
  // failure keeps the video
  let t = playerSetup();
  let v = t.mkVideo('one');
  let s = t.store.createSchedule({ userId: t.uid, title: 'X', videoIds: [v], startAt: t.nowMs(), loopCount: 1, destIds: null, deleteAfter: true });
  t.player.tick();
  t.procs[0].stderr.emit('data', Buffer.from('Connection refused\n'));
  t.procs[0].emit('close', 1, null);
  assert.equal(t.store.getSchedule(s).status, 'failed');
  assert.equal(t.store.getSchedule(s).error, 'Connection refused');
  assert.ok(t.store.getVideo(v), 'video kept after a failed live');

  // missed (server was down at the time)
  t = playerSetup(); v = t.mkVideo('one');
  s = t.store.createSchedule({ userId: t.uid, title: 'Late', videoIds: [v], startAt: t.nowMs() - 3_600_000, loopCount: 1, destIds: null, deleteAfter: true });
  t.player.tick();
  assert.equal(t.procs.length, 0);
  assert.equal(t.store.getSchedule(s).status, 'missed');

  // OBS already live on this key
  t = playerSetup({ ingestLive: true }); v = t.mkVideo('one');
  s = t.store.createSchedule({ userId: t.uid, title: 'Clash', videoIds: [v], startAt: t.nowMs(), loopCount: 1, destIds: null, deleteAfter: true });
  t.player.tick();
  assert.equal(t.procs.length, 0);
  assert.match(t.store.getSchedule(s).error, /already live from OBS/);

  // no enabled destination
  t = playerSetup(); v = t.mkVideo('one');
  t.store.updateDestination(t.dest, { enabled: false });
  s = t.store.createSchedule({ userId: t.uid, title: 'None', videoIds: [v], startAt: t.nowMs(), loopCount: 1, destIds: null, deleteAfter: true });
  t.player.tick();
  assert.match(t.store.getSchedule(s).error, /No enabled destination/);

  // cancel while running
  t = playerSetup(); v = t.mkVideo('one');
  s = t.store.createSchedule({ userId: t.uid, title: 'C', videoIds: [v], startAt: t.nowMs(), loopCount: 0, destIds: null, deleteAfter: true });
  t.player.tick();
  assert.ok(t.procs[0].args.includes('-stream_loop'));
  assert.equal(t.player.cancel(s), true);
  await sleep(10);
  assert.equal(t.store.getSchedule(s).status, 'cancelled');
  assert.ok(t.store.getVideo(v), 'cancelled live keeps the video');
  // cancel before start
  const s2 = t.store.createSchedule({ userId: t.uid, title: 'D', videoIds: [v], startAt: t.nowMs() + 99999, loopCount: 1, destIds: null, deleteAfter: true });
  assert.equal(t.player.cancel(s2), true);
  assert.equal(t.store.getSchedule(s2).status, 'cancelled');
  assert.equal(t.player.cancel(s2), false);

  // restart recovery
  t = playerSetup(); v = t.mkVideo('one');
  s = t.store.createSchedule({ userId: t.uid, title: 'R', videoIds: [v], startAt: t.nowMs(), loopCount: 1, destIds: null, deleteAfter: true });
  t.store.updateSchedule(s, { status: 'running' });
  t.player.start();
  assert.equal(t.store.getSchedule(s).status, 'failed');
  assert.match(t.store.getSchedule(s).error, /restarted/);
  t.player.shutdown();
});

test('player events create alerts', async () => {
  const store = openDb(':memory:');
  const uid = store.createUser({ email: 'a@x.com', name: 'A', passwordHash: 'h' });
  const sent = [];
  const h = playerEventHandler({ store, notifier: { send: async (u, m) => { sent.push(m); } } });
  h({ type: 'started', userId: uid, schedule: { title: 'News' }, destinations: 2 });
  h({ type: 'failed', userId: uid, schedule: { title: 'News', error: 'boom' } });
  h({ type: 'done', userId: uid, schedule: { title: 'News' } });
  assert.equal(sent.length, 3);
  assert.match(sent[1], /boom/);
  assert.ok(store.listActivity(uid).length >= 3);
});

// ---------------------------------------------------------------- API
async function boot() {
  const dataDir = tmp();
  const cfg = {
    dataDir, mediamtxApi: 'http://mtx', mediamtxRtmp: 'rtmp://mtx:1935', publicRtmpUrl: 'rtmp://r.example.com/live',
    ffmpegBin: 'ffmpeg', ffprobeBin: 'ffprobe', pollMs: 1000, backoffBaseMs: 20, backoffMaxMs: 80, stableMs: 30,
    maxDestinationsPerUser: 10, maxUploadBytes: 5_000_000, userQuotaBytes: 8_000_000, diskReserveBytes: 0,
    lateStartMs: 600000, schedulePollMs: 100000, alertUrl: '',
  };
  const store = openDb(':memory:');
  const vault = makeVault('s'.repeat(20));
  const opId = store.createUser({ email: 'op@x.com', name: 'Op', passwordHash: hashPassword('operpass1'), role: 'operator' });
  const op2Id = store.createUser({ email: 'o2@x.com', name: 'O2', passwordHash: hashPassword('operpass2'), role: 'operator' });
  const relay = new RelayManager({ store, vault, cfg, internalToken: 'T', fetchImpl: async () => ({ ok: true, json: async () => ({ items: [] }) }), spawn() { throw new Error('no'); }, log: quietLog });
  const enqueued = [];
  const processor = { enqueue: (id) => enqueued.push(id) };
  const procs = [];
  const player = new SchedulePlayer({
    store, cfg, relay, notifier: null, dataDir, log: quietLog,
    spawn: () => { const p = new EventEmitter(); p.stderr = new EventEmitter(); p.kill = () => setImmediate(() => p.emit('close', null, 'SIGTERM')); procs.push(p); return p; },
  });
  const server = createApp({ cfg, store, relay, internalToken: 'T', processor, player, log: quietLog });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  server.unref(); // a failing test must not leave the runner hanging
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = async (email, password) => {
    let cookie = '';
    const call = async (method, p, body, { raw, headers } = {}) => {
      const res = await fetch(base + p, {
        method, headers: { 'x-requested-with': 'vivid', cookie, ...(raw ? { 'content-type': 'application/octet-stream' } : { 'content-type': 'application/json' }), ...headers },
        body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
      });
      const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
      const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* */ }
      return { status: res.status, json, text };
    };
    await call('POST', '/api/login', { email, password });
    return call;
  };
  return { store, cfg, opId, op2Id, enqueued, client, dataDir, close: () => new Promise((r) => server.close(r)) };
}

test('API: resumable chunked upload, resume after mismatch, validation, quota', async () => {
  const t = await boot();
  const op = await t.client('op@x.com', 'operpass1');
  assert.equal((await op('POST', '/api/uploads', { filename: 'evil.exe', size: 10 })).status, 400);
  assert.equal((await op('POST', '/api/uploads', { filename: 'a.mp4', size: 99_000_000 })).status, 400, 'bigger than max');
  assert.equal((await op('POST', '/api/uploads', { filename: 'a.mp4', size: 0 })).status, 400);

  const data = Buffer.alloc(3000, 7);
  const c = await op('POST', '/api/uploads', { filename: '../../etc/My Show.mp4', size: data.length });
  assert.equal(c.status, 201);
  const id = c.json.id;
  const v = t.store.getVideo(id);
  assert.ok(v.file_path.startsWith(path.join(t.dataDir, 'videos')) && !v.file_path.includes('etc'), 'user file name never used in path');
  assert.equal(v.title, 'My Show');

  assert.equal((await op('PUT', `/api/uploads/${id}?offset=0`, undefined, { raw: data.subarray(0, 1000) })).json.received, 1000);
  const wrong = await op('PUT', `/api/uploads/${id}?offset=0`, undefined, { raw: data.subarray(0, 1000) });
  assert.equal(wrong.status, 409);
  assert.equal(wrong.json.received, 1000, 'server tells the client where to resume');
  assert.equal((await op('GET', `/api/uploads/${id}`)).json.received, 1000);
  assert.equal((await op('POST', `/api/uploads/${id}/complete`)).status, 400, 'incomplete');
  assert.equal((await op('PUT', `/api/uploads/${id}?offset=1000`, undefined, { raw: Buffer.alloc(5000) })).status, 400, 'past end');
  assert.equal((await op('PUT', `/api/uploads/${id}?offset=1000`, undefined, { raw: data.subarray(1000) })).json.received, 3000);
  assert.equal((await op('POST', `/api/uploads/${id}/complete`)).status, 200);
  assert.deepEqual(t.enqueued, [id]);
  assert.equal(t.store.getVideo(id).status, 'processing');
  assert.deepEqual(fs.readFileSync(t.store.getVideo(id).file_path), data);
  assert.equal((await op('DELETE', `/api/videos/${id}`)).status, 409, 'cannot delete while processing');

  // another user cannot touch it
  const o2 = await t.client('o2@x.com', 'operpass2');
  assert.equal((await o2('GET', `/api/uploads/${id}`)).status, 404);
  assert.equal((await o2('PUT', `/api/uploads/${id}?offset=0`, undefined, { raw: Buffer.alloc(1) })).status, 404);

  // quota
  t.store.updateVideo(id, { status: 'ready' });
  const big = await op('POST', '/api/uploads', { filename: 'b.mp4', size: 5_000_000 });
  assert.equal(big.status, 201);
  assert.equal((await op('POST', '/api/uploads', { filename: 'c.mp4', size: 4_000_000 })).status, 400, 'quota full');
  assert.equal((await op('DELETE', `/api/videos/${big.json.id}`)).status, 200);
  assert.ok(!fs.existsSync(t.store.getVideo(id).file_path) === false);
  const st = await op('GET', '/api/storage');
  assert.equal(st.status, 200);
  assert.ok(st.json.freeBytes > 0);
  await t.close();
});

test('API: schedule validation, overlap, ownership, cancel, phone', async () => {
  const t = await boot();
  const op = await t.client('op@x.com', 'operpass1');
  const o2 = await t.client('o2@x.com', 'operpass2');
  const vault = makeVault('s'.repeat(20));
  const dest = t.store.createDestination({ userId: t.opId, name: 'YT', platform: 'youtube', rtmpUrl: 'rtmp://a.example.com/x', keyEnc: vault.encrypt('kkkk1') });
  const mk = (uid, title, o = {}) => {
    const f = path.join(t.dataDir, `${title}.mp4`); fs.writeFileSync(f, 'x');
    const id = t.store.createVideo({ userId: uid, title, filePath: f, ext: 'mp4', expectedSize: 1 });
    t.store.updateVideo(id, { status: o.status || 'ready', duration: o.duration ?? 600, width: o.w || 1920, height: o.h || 1080, fps: o.fps || 30 });
    return id;
  };
  const a = mk(t.opId, 'a'); const b = mk(t.opId, 'b'); const c720 = mk(t.opId, 'c', { w: 1280, h: 720 });
  const notReady = mk(t.opId, 'n', { status: 'processing' });
  const other = mk(t.op2Id, 'other');
  const at = (mins) => Date.now() + mins * 60000;

  assert.equal((await op('POST', '/api/schedules', { video_ids: [a], start_at: at(-60) })).status, 400, 'past');
  assert.equal((await op('POST', '/api/schedules', { video_ids: [], start_at: at(60) })).status, 400);
  assert.equal((await op('POST', '/api/schedules', { video_ids: [other], start_at: at(60) })).status, 400, "someone else's video");
  assert.equal((await op('POST', '/api/schedules', { video_ids: [notReady], start_at: at(60) })).status, 400, 'not ready');
  assert.equal((await op('POST', '/api/schedules', { video_ids: [a, c720], start_at: at(60) })).status, 400, 'mixed resolution');
  assert.equal((await op('POST', '/api/schedules', { video_ids: [a], start_at: at(60), dest_ids: [9999] })).status, 400);
  assert.equal((await op('POST', '/api/schedules', { video_ids: [a], start_at: at(60), loop_count: 99 })).status, 400);

  const ok = await op('POST', '/api/schedules', { video_ids: [a, b], start_at: at(60), title: 'Evening news', dest_ids: [dest] });
  assert.equal(ok.status, 201, ok.text);
  const sid = ok.json.schedule.id;
  assert.deepEqual(ok.json.schedule.videos, ['a', 'b']);

  const clash = await op('POST', '/api/schedules', { video_ids: [b], start_at: at(65) });
  assert.equal(clash.status, 409, 'overlaps the 20 minute playlist that starts at +60');
  assert.equal((await op('POST', '/api/schedules', { video_ids: [b], start_at: at(120) })).status, 201, 'later slot is fine');
  assert.equal((await op('DELETE', `/api/videos/${a}`)).status, 409, 'video used by schedule');

  assert.equal((await o2('GET', '/api/schedules')).json.schedules.length, 0);
  assert.equal((await o2('POST', `/api/schedules/${sid}/cancel`)).status, 404);
  assert.equal((await op('POST', `/api/schedules/${sid}/cancel`)).status, 200);
  assert.equal((await op('POST', `/api/schedules/${sid}/cancel`)).status, 409);
  assert.equal((await op('DELETE', `/api/videos/${a}`)).status, 200, 'free after cancel');

  assert.equal((await op('PATCH', '/api/me', { phone: 'abc' })).status, 400);
  assert.equal((await op('PATCH', '/api/me', { phone: '+91 98765-43210' })).status, 200);
  assert.equal((await op('GET', '/api/me/settings')).json.phone, '+919876543210');
  await t.close();
});

test('db migration adds users.phone to a phase-1 database', () => {
  const dir = tmp();
  const old = new DatabaseSync(path.join(dir, 'vivid-stream.db'));
  old.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'operator', ingest_key TEXT NOT NULL UNIQUE,
    active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO users (email,name,password_hash,role,ingest_key) VALUES ('old@x.com','Old','h','admin','abc');`);
  old.close();
  const s = openDb(dir);
  const u = s.getUserByEmail('old@x.com');
  assert.equal(u.phone, '');
  s.updateUser(u.id, { phone: '919876543210' });
  assert.equal(s.getUser(u.id).phone, '919876543210');
  s.close();
  openDb(dir).close(); // opening twice must not fail
});
